import { readFile } from "node:fs/promises";
const failures = [];
const requireValue = (name, valid) => { if (!valid) failures.push(name); };
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
requireValue("Production entry must be index.ts", pkg.main === "index.ts");
requireValue("EXPO_OWNER: select the real Expo organization", process.env.EXPO_OWNER);
requireValue("EXPO_PUBLIC_EAS_PROJECT_ID: link the real project", /^[a-f0-9-]{36}$/i.test(process.env.EXPO_PUBLIC_EAS_PROJECT_ID || ""));
if (process.argv.includes("--submit")) {
  let evidence = {};
  try { evidence = JSON.parse(await readFile(new URL("../release/device-verification.json", import.meta.url), "utf8")); } catch { failures.push("Missing real-device verification record"); }
  for (const key of ["googleLogin", "appleLogin", "dailySubmission", "workspaceIsolation", "accountDeletion", "systemText200Percent", "screenReader", "privacyDeclarationsReviewed", "dependencyAdvisoriesReviewed"]) requireValue(key + " is not verified", evidence[key] === true);
  for (const key of ["iosBuildId", "androidBuildId"]) requireValue(key + " must reference a real EAS build", /^[a-f0-9-]{36}$/i.test(evidence[key] || ""));
  try {
    const response = await fetch("https://okri.ai/api/native/apple", { signal: AbortSignal.timeout(10000) });
    requireValue("Production Apple login is not enabled", response.ok && (await response.json()).enabled === true);
  } catch { failures.push("Production native API is not reachable"); }
}
if (failures.length) { console.error("Release blocked:\n" + failures.map(line => "- " + line).join("\n")); process.exitCode = 1; }
else console.log("Preflight passed. Store accounts, signed artifacts and review status still require verification.");
