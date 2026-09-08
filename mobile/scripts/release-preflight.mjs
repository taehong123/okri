import { readFileSync, existsSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { git, root, sourceDigest, uuid, validateEvidence } from "./release-lib.mjs";
import path from "node:path";

export async function preflight({ platform, kind = "build", online = true }) {
  if (!["ios", "android"].includes(platform)) throw new Error("Select ios or android explicitly");
  if (!["build", "submit", "ota"].includes(kind)) throw new Error("Unknown release kind");
  const read = file => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  if (git("status", "--porcelain")) throw new Error("Commit the reviewed sources before release");
  if (read("mobile/package.json").main !== "index.ts" || process.env.OKRI_PREVIEW) throw new Error("Preview code cannot be released");
  if (!process.env.EXPO_OWNER || !uuid(process.env.EXPO_PUBLIC_EAS_PROJECT_ID)) throw new Error("Link the real Expo owner/project before release");
  const policy = read("mobile/release/update-policy.json");
  if (!["disabled", "signed"].includes(policy.ota)) throw new Error("Invalid OTA policy");
  if (policy.ota === "signed") {
    const cert = path.join(root, "mobile/release/update-certificate.pem");
    if (!existsSync(cert)) throw new Error("Signed OTA requires its public certificate in the app binary");
    const certificate = new X509Certificate(readFileSync(cert));
    if (Date.parse(certificate.validTo) < Date.now() + 365 * 86400000) throw new Error("Update certificate needs at least one year of validity");
  }
  let evidence, artifact;
  if (kind !== "build") {
    evidence = read("mobile/release/device-verification.json");
    artifact = validateEvidence(evidence, { platform, kind, digest: sourceDigest() });
    // A matching digest does not establish that a claimed source commit exists.
    git("cat-file", "-e", evidence.sourceCommit + "^{commit}");
    const changed = git("diff", "--name-only", evidence.sourceCommit, "HEAD", "--", "mobile", "lib", "app/api", "drizzle", "package.json", "package-lock.json")
      .split("\n").filter(p => p && !/^mobile\/release\/(?:device-verification|candidate)\.json$/.test(p));
    if (changed.length) throw new Error("Evidence source commit differs from these release inputs");
  }
  if (kind === "ota" && (policy.ota !== "signed" || !process.env.OKRI_UPDATE_PRIVATE_KEY_PATH || !existsSync(process.env.OKRI_UPDATE_PRIVATE_KEY_PATH))) throw new Error("OTA is disabled until signed updates and private-key storage are configured");
  if (online) {
    const response = await fetch("https://okri.ai/api/mobile/v1/policy?platform=" + platform, { signal: AbortSignal.timeout(10000) });
    const server = await response.json();
    if (!response.ok || server.apiVersion !== 1 || server.platform !== platform) throw new Error("Production mobile API v1 is not available");
    if (platform === "ios") {
      const response = await fetch("https://okri.ai/api/native/apple", { signal: AbortSignal.timeout(10000) });
      if (!response.ok || (await response.json()).enabled !== true) throw new Error("Production Apple sign-in must be enabled before an iOS release");
    }
  }
  return { evidence, artifact };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(root, "mobile/scripts/release-preflight.mjs")) {
  try {
    await preflight({ platform: process.argv.includes("--ios") ? "ios" : "android", kind: process.argv.includes("--submit") ? "submit" : "build" });
    console.log("Preflight passed. No build or submission was performed.");
  } catch (error) { console.error("Release blocked: " + error.message); process.exitCode = 1; }
}
