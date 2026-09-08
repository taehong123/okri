import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export function git(...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
export function sourceDigest() {
  // Receipts are not executable input and can be committed after device testing.
  // Hash canonical Git blobs, not platform-dependent checkout line endings.
  // Preflight requires a clean tree; CI creates candidates from committed input.
  const entries = git("ls-files", "--stage", "-z", "--", "mobile", "lib", "app/api", "drizzle", "package.json", "package-lock.json").split("\0").filter(Boolean);
  const digest = createHash("sha256");
  for (const entry of entries.sort()) {
    const match = entry.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/);
    if (!match || match[3] !== "0") throw new Error("Unmerged release inputs");
    if (/^mobile\/release\/(?:device-verification|candidate)\.json$/.test(match[4])) continue;
    digest.update(entry + "\0");
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
