import { spawnSync } from "node:child_process";
import { preflight } from "./release-preflight.mjs";
const platform = process.argv[2], kind = process.argv[3];
try {
  const { artifact } = await preflight({ platform, kind });
  const args = kind === "build" ? ["build", "--platform", platform, "--profile", "production", "--non-interactive"]
    : kind === "submit" ? ["submit", "--platform", platform, "--profile", "production", "--id", artifact.buildId, "--non-interactive"]
    : ["update:republish", "--group", artifact.updateGroupId, "--destination-channel", "production", "--platform", platform, "--rollout-percentage", "10", "--private-key-path", process.env.OKRI_UPDATE_PRIVATE_KEY_PATH, "--non-interactive"];
  // Never --latest: promote exactly the tested build/group, one platform at a time.
  if (!process.env.npm_execpath?.endsWith("npm-cli.js")) throw new Error("Run a documented npm release script");
  const result = spawnSync(process.execPath, [process.env.npm_execpath, "exec", "--yes", "--package=eas-cli@23.2.0", "--", "eas", ...args], { stdio: "inherit", cwd: new URL("../", import.meta.url) });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) { console.error("Release blocked: " + error.message); process.exitCode = 1; }
