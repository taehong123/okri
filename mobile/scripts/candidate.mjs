import { writeFileSync, mkdirSync } from "node:fs";
import { git, root, sourceDigest } from "./release-lib.mjs";
import path from "node:path";
const sourceCommit = git("rev-parse", "HEAD");
if (git("status", "--porcelain")) throw new Error("Commit sources before recording a release candidate");
const since = process.env.OKRI_PREVIOUS_MOBILE_COMMIT;
const changed = since ? git("diff", "--name-only", since, sourceCommit).split("\n") : git("ls-files", "mobile", "lib", "app/api").split("\n");
const native = changed.filter(p => p.startsWith("mobile/"));
const server = changed.filter(p => /^(?:app\/api\/|lib\/|drizzle\/)/.test(p));
const web = changed.filter(p => /^(?:app\/|components\/)/.test(p) && !p.startsWith("app/api/"));
const report = {
  schemaVersion: 1, sourceCommit, sourceDigest: sourceDigest(), createdAt: new Date().toISOString(),
  nativeChanges: native, serverOrSharedChanges: server, webUIChanges: web,
  disposition: "candidate-only; device verification and exact-artifact promotion required",
  parityReview: "Web UI changes are not automatically implemented in native screens. Classify each product change before the next store release.",
};
mkdirSync(path.join(root, "mobile/artifacts"), { recursive: true });
writeFileSync(path.join(root, "mobile/artifacts/candidate.json"), JSON.stringify(report, null, 2) + "\n");
console.log("Candidate recorded for " + sourceCommit + ". No store publication performed.");
