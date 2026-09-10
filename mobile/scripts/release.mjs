import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflight } from "./release-preflight.mjs";
import { git, sourceDigest } from "./release-lib.mjs";

const platform = process.argv[2];
const mobileRoot = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(mobileRoot, "artifacts");
process.env.NODE_ENV ??= "production";
const required = name => {
  const value = process.env[name];
  if (!value) throw new Error("Missing release secret: " + name);
  return value;
};
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: options.cwd ?? mobileRoot,
  env: process.env,
  stdio: "inherit",
});
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const version = JSON.parse(readFileSync(path.join(mobileRoot, "package.json"), "utf8")).version;

try {
  await preflight({ platform });
  run(process.execPath, [path.join(mobileRoot, "node_modules", "expo", "bin", "cli"), "prebuild", "--platform", platform, "--clean", "--no-install"]);
  mkdirSync(artifacts, { recursive: true });

  let source;
  let buildNumber;
  if (platform === "android") {
    for (const key of ["OKRI_UPLOAD_STORE_FILE", "OKRI_UPLOAD_STORE_PASSWORD", "OKRI_UPLOAD_KEY_ALIAS", "OKRI_UPLOAD_KEY_PASSWORD"]) required(key);
    run(process.execPath, [path.join(mobileRoot, "scripts", "configure-android-release.mjs")]);
    if (process.platform === "win32") {
      run(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "gradlew.bat bundleRelease"], { cwd: path.join(mobileRoot, "android") });
    } else {
      run("./gradlew", ["bundleRelease"], { cwd: path.join(mobileRoot, "android") });
    }
    source = path.join(mobileRoot, "android", "app", "build", "outputs", "bundle", "release", "app-release.aab");
    buildNumber = process.env.OKRI_ANDROID_VERSION_CODE ?? "1";
  } else if (platform === "ios") {
    if (process.platform !== "darwin") throw new Error("iOS must be compiled on the GitHub macOS runner");
    const teamId = required("APPLE_TEAM_ID");
    const keyId = required("ASC_KEY_ID");
    const issuerId = required("ASC_ISSUER_ID");
    const keyPath = required("ASC_KEY_PATH");
    const archive = path.join(artifacts, "OKRI.xcarchive");
    const exportPath = path.join(artifacts, "ios-export");
    const exportOptions = path.join(artifacts, "ExportOptions.plist");
    writeFileSync(exportOptions, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>signingStyle</key><string>automatic</string>
<key>teamID</key><string>${teamId}</string>
<key>uploadSymbols</key><true/>
</dict></plist>\n`, "utf8");
    const auth = ["-allowProvisioningUpdates", "-authenticationKeyPath", keyPath, "-authenticationKeyID", keyId, "-authenticationKeyIssuerID", issuerId];
    run("xcodebuild", ["-workspace", "ios/OKRI.xcworkspace", "-scheme", "OKRI", "-configuration", "Release", "-destination", "generic/platform=iOS", "-archivePath", archive, "DEVELOPMENT_TEAM=" + teamId, "CODE_SIGN_STYLE=Automatic", ...auth, "archive"]);
    run("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportPath", exportPath, "-exportOptionsPlist", exportOptions, ...auth]);
    const ipa = readdirSync(exportPath).find(file => file.endsWith(".ipa"));
    if (!ipa) throw new Error("Xcode did not produce an IPA");
    source = path.join(exportPath, ipa);
    buildNumber = process.env.OKRI_IOS_BUILD_NUMBER ?? "1";
  } else {
    throw new Error("Select android or ios explicitly");
  }

  if (!existsSync(source)) throw new Error("Expected signed store artifact was not created");
  const extension = platform === "android" ? "aab" : "ipa";
  const destination = path.join(artifacts, `okri-${platform}-${version}-${buildNumber}.${extension}`);
  copyFileSync(source, destination);
  const manifest = {
    schemaVersion: 1,
    platform,
    version,
    buildNumber,
    sourceCommit: git("rev-parse", "HEAD"),
    sourceDigest: sourceDigest(),
    artifact: path.basename(destination),
    artifactSha256: sha256(destination),
    createdAt: new Date().toISOString(),
    updateLane: "store-binary-only",
  };
  writeFileSync(path.join(artifacts, `okri-${platform}-manifest.json`), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  console.error("Release blocked: " + error.message);
  process.exitCode = 1;
}
