import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export function git(...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
export function sourceDigest() {
  // Receipts are not executable input and can be committed after device testing.
  const files = git("ls-files", "-z", "--", "mobile", "lib", "app/api", "drizzle", "package.json", "package-lock.json")
    .split("\0").filter(f => f && !/^mobile\/release\/(?:device-verification|candidate)\.json$/.test(f)).sort();
  const digest = createHash("sha256");
  for (const file of files) {
    const bytes = readFileSync(path.join(root, file));
    const input = /\.(?:tsx?|jsx?|mjs|cjs|json|sql|md|ya?ml|css)$/.test(file) ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n")) : bytes;
    digest.update(file + "\0" + input.length + "\0").update(input);
  }
  return digest.digest("hex");
}
export function validateEvidence(evidence, { platform, kind, digest, now = Date.now() }) {
  if (!evidence || evidence.schemaVersion !== 1 || !sha(evidence.sourceCommit) || evidence.sourceDigest !== digest) throw new Error("Device evidence does not match these sources");
  const checked = Date.parse(evidence.checkedAt);
  if (!Number.isFinite(checked) || checked > now + 300000 || now - checked > 14 * 86400000) throw new Error("Device evidence is missing, future-dated or older than 14 days");
  if (typeof evidence.reviewedBy !== "string" || !evidence.reviewedBy.trim()) throw new Error("A named release reviewer is required");
  const p = evidence[platform];
  if (!p || !uuid(p.buildId) || !/^[a-f0-9]{64}$/.test(p.artifactSha256 || "") || !/^[a-f0-9]{40,64}$/.test(p.runtimeVersion || "") || typeof p.device !== "string" || !p.device.trim() || typeof p.osVersion !== "string" || !p.osVersion.trim()) throw new Error("Exact signed artifact, runtime and physical device are required");
  for (const check of ["googleLogin", ...(platform === "ios" ? ["appleLogin"] : []), "dailySubmission", "workspaceIsolation", "accountDeletion", "systemText200Percent", "screenReader", "previousClientAgainstCurrentServer", "offlineStart", "rollback", "privacyDeclarationsReviewed", "dependencyAdvisoriesReviewed"]) {
    if (p.checks?.[check] !== true) throw new Error("Unverified check: " + check);
  }
  if (kind === "ota") {
    if (!["bugfix", "translation", "assets"].includes(evidence.changeKind)) throw new Error("New functionality/native changes require store review");
    if (!uuid(p.updateGroupId) || p.testedRuntimeVersion !== p.runtimeVersion || p.checks?.coldStartUpdate !== true || p.checks?.storePolicyReviewed !== true) throw new Error("OTA needs the exact tested group/runtime and store-policy review");
  }
  return p;
}
