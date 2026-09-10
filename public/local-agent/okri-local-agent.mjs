#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = "0.1.0";
const POLL_INTERVAL_MS = 3_000;
const REPORT_INTERVAL_MS = 30_000;

export function parseArgs(argv) {
  const result = { url: "https://okri.ai", code: "", token: "", cwd: process.cwd(), name: "", once: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--once") { result.once = true; continue; }
    if (!["--url", "--code", "--token", "--cwd", "--name"].includes(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    result[argument.slice(2)] = value;
    index += 1;
  }
  result.token ||= process.env.OKRI_LOCAL_AGENT_TOKEN ?? "";
  result.name ||= `${process.env.COMPUTERNAME || process.env.HOSTNAME || "My computer"}`;
  return result;
}

export function validateBaseUrl(value) {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("OKRI URL must use HTTPS. HTTP is allowed only for localhost.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function sanitizedCodexEnvironment(source = process.env) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE/i.test(key)) continue;
    result[key] = value;
  }
  return result;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function requestJson(baseUrl, path, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof payload.error === "string" ? payload.error : `OKRI request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

export class CodexAppServer {
  constructor(cwd) {
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
    this.threads = new Map();
    this.activeTurn = null;
  }

  async start() {
    const windows = process.platform === "win32";
    const command = windows ? process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe" : "codex";
    const args = windows
      ? ["/d", "/s", "/c", 'codex.cmd app-server -c mcp_servers={} -c web_search="disabled"']
      : ["app-server", "-c", "mcp_servers={}", "-c", 'web_search="disabled"'];
    this.child = spawn(command, args, {
      cwd: this.cwd,
      env: sanitizedCodexEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code) => this.failAll(new Error(`Codex App Server stopped (${code ?? "unknown"}).`)));
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    createInterface({ input: this.child.stderr }).on("line", (line) => {
      if (/error|failed|panic/i.test(line)) process.stderr.write(`[Codex] ${line}\n`);
    });
    await this.request("initialize", {
      clientInfo: { name: "okri_local_agent", title: "OKRI Local Agent", version: VERSION },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  send(message) {
    if (!this.child?.stdin.writable) throw new Error("Codex App Server is not running.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.send({ method, id, params });
    });
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (message.id !== undefined && message.method) {
      if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
        this.send({ id: message.id, result: { decision: "decline" } });
      } else {
        this.send({ id: message.id, error: { code: -32601, message: "Interactive tools are disabled for OKRI local jobs." } });
      }
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex request failed."));
      else pending.resolve(message.result);
      return;
    }
    this.receiveNotification(message);
  }

  receiveNotification(message) {
    const active = this.activeTurn;
    if (!active) return;
    if (message.method === "item/agentMessage/delta" && message.params?.turnId === active.turnId) {
      active.text += message.params.delta ?? "";
      return;
    }
    if (message.method === "item/completed" && message.params?.turnId === active.turnId && message.params.item?.type === "agentMessage") {
      active.text = message.params.item.text || active.text;
      return;
    }
    if (message.method === "turn/completed" && message.params?.turn?.id === active.turnId) {
      this.activeTurn = null;
      const turn = message.params.turn;
      if (turn.status === "completed") active.resolve(active.text.trim() || "Codex completed without a text summary.");
      else active.reject(new Error(turn.error?.message || `Codex turn ${turn.status}.`));
    }
  }

  async run(targetKey, prompt) {
    let threadId = this.threads.get(targetKey);
    if (!threadId) {
      const response = await this.request("thread/start", {
        cwd: this.cwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: true,
        dynamicTools: [],
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
      threadId = response.thread.id;
      this.threads.set(targetKey, threadId);
    }
    const sandboxPolicy = {
      type: "workspaceWrite",
      writableRoots: [this.cwd],
      readOnlyAccess: { type: "restricted", includePlatformDefaults: true, readableRoots: [this.cwd] },
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
    const response = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: this.cwd,
      approvalPolicy: "never",
      sandboxPolicy,
    });
    return new Promise((resolvePromise, reject) => {
      this.activeTurn = { turnId: response.turn.id, text: "", resolve: resolvePromise, reject };
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.activeTurn) this.activeTurn.reject(error);
    this.activeTurn = null;
  }

  stop() {
    this.child?.kill();
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = validateBaseUrl(options.url);
  const cwd = isAbsolute(options.cwd) ? options.cwd : resolve(options.cwd);
  await access(cwd);
  if (!options.code && !options.token) throw new Error("Use --code for first connection or OKRI_LOCAL_AGENT_TOKEN for this process.");

  let token = options.token;
  if (!token) {
    const paired = await requestJson(baseUrl, "/api/local-agent/pair", {
      body: { code: options.code, name: options.name, platform: `${process.platform}-${process.arch}` },
    });
    token = paired.token;
    process.stdout.write(`Connected as ${paired.device.name}. The token stays only in this process.\n`);
  }

  const codex = new CodexAppServer(cwd);
  await codex.start();
  process.stdout.write(`OKRI Local Agent is ready in ${cwd}. Press Ctrl+C to stop.\n`);
  let stopped = false;
  const stop = () => { stopped = true; codex.stop(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let processed = 0;

  while (!stopped) {
    try {
      const { job } = await requestJson(baseUrl, "/api/local-agent/jobs/next", { token });
      if (!job) {
        if (options.once && processed > 0) break;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      processed += 1;
      process.stdout.write(`Running ${job.targetKind}: ${job.targetTitle}\n`);
      const reportProgress = setInterval(() => {
        void requestJson(baseUrl, "/api/local-agent/jobs/report", {
          token,
          body: { id: job.id, leaseId: job.leaseId, status: "running", progressText: "Codex is working locally" },
        }).catch(() => undefined);
      }, REPORT_INTERVAL_MS);
      try {
        const resultText = await codex.run(`${job.targetKind}:${job.targetId}`, job.prompt);
        await requestJson(baseUrl, "/api/local-agent/jobs/report", {
          token,
          body: { id: job.id, leaseId: job.leaseId, status: "completed", progressText: "Completed", resultText },
        });
        process.stdout.write(`Completed: ${job.targetTitle}\n`);
      } catch (error) {
        const errorText = error instanceof Error ? error.message : "Local Codex failed.";
        await requestJson(baseUrl, "/api/local-agent/jobs/report", {
          token,
          body: { id: job.id, leaseId: job.leaseId, status: "failed", progressText: "Failed", errorText },
        }).catch(() => undefined);
        process.stderr.write(`Failed: ${errorText}\n`);
      } finally {
        clearInterval(reportProgress);
      }
      if (options.once) break;
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) throw error;
      process.stderr.write(`Temporary connection error: ${error instanceof Error ? error.message : String(error)}\n`);
      await sleep(5_000);
    }
  }
  codex.stop();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) run().catch((error) => {
  process.stderr.write(`OKRI Local Agent stopped: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
