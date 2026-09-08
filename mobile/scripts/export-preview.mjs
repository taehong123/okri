import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["node_modules/expo/bin/cli", "export", "--platform", "web", "--output-dir", "preview-dist", "--max-workers", "1", "--clear"], {
  cwd: new URL("../", import.meta.url), stdio: "inherit",
  env: { ...process.env, OKRI_PREVIEW: "1", EXPO_OFFLINE: "1", CI: "1" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
