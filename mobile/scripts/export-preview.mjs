import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const url = new URL("../package.json", import.meta.url), original = await readFile(url, "utf8");
try {
  const data = JSON.parse(original);
  if (data.main !== "index.ts") throw new Error("Unexpected production entry point");
  await writeFile(url, JSON.stringify({ ...data, main: "preview/index.tsx" }, null, 2) + "\n");
  const result = spawnSync(process.execPath, ["node_modules/expo/bin/cli", "export", "--platform", "web", "--output-dir", "preview-dist", "--max-workers", "1"], { cwd: new URL("../", import.meta.url), stdio: "inherit", env: { ...process.env, EXPO_OFFLINE: "1", CI: "1" } });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
} finally { await writeFile(url, original); }
