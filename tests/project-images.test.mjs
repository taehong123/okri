import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../lib/project-images.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;
const loaded = { exports: {} };
const runtimeEnv = {};
let slackFileInfo = {};
new Function("require", "module", "exports", compiled)((name) => ({
  "cloudflare:workers": { env: runtimeEnv },
  "@/lib/slack-daily": { slackApi: async () => slackFileInfo },
})[name] ?? require(name), loaded, loaded.exports);

const { arrayBufferToBase64, readSlackImagesForAgent, saveSlackProjectImages, verifiedImageType } = loaded.exports;

test("Project image validation accepts supported signatures and rejects declared-only files", () => {
  assert.equal(verifiedImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(verifiedImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(verifiedImageType(new TextEncoder().encode("GIF89a")), "image/gif");
  assert.equal(verifiedImageType(new TextEncoder().encode("not-an-image")), null);
});

test("Project image bytes are encoded for MCP image content without data URLs", () => {
  assert.equal(arrayBufferToBase64(Uint8Array.from([0, 1, 2, 253, 254, 255])), "AAEC/f7/");
});

test("Slack thread images can be supplied to the agent without exposing the bot token", async () => {
  slackFileInfo = { file: {
    id: "F1", name: "thread.png", mimetype: "image/png", size: 8,
    url_private_download: "https://files.slack.com/files-pri/T-F/download/thread.png",
  } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer xoxb-agent");
    return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { status: 200 });
  };
  try {
    const images = await readSlackImagesForAgent("xoxb-agent", [
      { id: "F1", name: "stale", mimeType: "image/png", size: 8, urlPrivateDownload: "" },
    ]);
    assert.deepEqual(images, [{ name: "thread.png", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    assert.ok(!JSON.stringify(images).includes("xoxb-agent"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Slack thread images use complete message metadata without files.info", async () => {
  slackFileInfo = {};
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    assert.equal(options.headers.Authorization, "Bearer xoxb-agent");
    assert.equal(options.redirect, "manual");
    if (calls === 1) {
      assert.match(String(url), /^https:\/\/files\.slack\.com\//);
      return new Response(null, { status: 302, headers: { location: "https://slack-files.com/download/signed-image" } });
    }
    assert.equal(String(url), "https://slack-files.com/download/signed-image");
    return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { status: 200 });
  };
  try {
    const images = await readSlackImagesForAgent("xoxb-agent", [{
      id: "F2", name: "inquiry.png", mimeType: "image/png", size: 8,
      urlPrivateDownload: "https://files.slack.com/files-pri/T-F/download/inquiry.png",
    }]);
    assert.deepEqual(images, [{ name: "inquiry.png", mimeType: "image/png", data: "iVBORw0KGgo=" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Slack images are copied to private Project storage without persisting Slack URLs or tokens", async () => {
  const calls = [];
  const objects = new Map();
  runtimeEnv.DB = {
    prepare(sql) {
      return {
        bind(...values) {
          calls.push({ sql, values });
          return {
            async first() {
              if (sql.includes("FROM items")) return { id: "project" };
              if (sql.includes("FROM project_images")) return null;
              throw new Error(`Unexpected first: ${sql}`);
            },
            async run() { return { meta: { changes: 1 } }; },
          };
        },
      };
    },
  };
  runtimeEnv.WORKSPACE_AVATARS = {
    async put(key, bytes, options) { objects.set(key, { bytes: new Uint8Array(bytes), options }); },
    async delete(key) { objects.delete(key); },
  };
  slackFileInfo = { file: {
    id: "F1", name: "error.png", mimetype: "image/png", size: 8,
    url_private_download: "https://files.slack.com/files-pri/T-F/download/error.png",
  } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer xoxb-secret");
    assert.equal(options.redirect, "manual");
    return new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { status: 200 });
  };
  try {
    const result = await saveSlackProjectImages({
      ownerId: "workspace", projectId: "project", createdByUserId: "user", teamId: "T1", token: "xoxb-secret",
      files: [{ id: "F1", name: "stale", mimeType: "image/png", size: 8, urlPrivateDownload: "" }],
    });
    assert.deepEqual(result, { found: 1, saved: 1, reused: 0, skipped: 0, failed: 0 });
    assert.equal(objects.size, 1);
    assert.equal([...objects.values()][0].options.httpMetadata.contentType, "image/png");
    const persistedValues = calls.flatMap((call) => call.values).map(String).join(" ");
    assert.ok(!persistedValues.includes("xoxb-secret"));
    assert.ok(!persistedValues.includes("files.slack.com"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
