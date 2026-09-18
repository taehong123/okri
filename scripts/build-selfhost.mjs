import { spawnSync } from "node:child_process";

const env = { ...process.env, OKRI_RUNTIME: "selfhost" };
// The Node server renders the application itself. `publish-prerender.mjs`
// packages the Cloudflare static shell and intentionally is not part of the
// self-hosted artifact.
for (const [command, args] of [
  [process.execPath, ["--experimental-sqlite", "node_modules/vinext/dist/cli.js", "build"]],
]) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
