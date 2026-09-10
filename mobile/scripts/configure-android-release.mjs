import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = fileURLToPath(new URL("../", import.meta.url));
const buildFile = path.join(mobileRoot, "android", "app", "build.gradle");

if (!existsSync(buildFile)) throw new Error("Generate the Android project before configuring signing");

let source = readFileSync(buildFile, "utf8").replace(/\r\n/g, "\n");
const marker = "// OKRI_RELEASE_SIGNING";
if (!source.includes(marker)) {
  const signingStart = "    signingConfigs {\n        debug {";
  const releaseSigning = `    signingConfigs {
        release {
            // OKRI_RELEASE_SIGNING
            def uploadStoreFile = System.getenv('OKRI_UPLOAD_STORE_FILE')
            def uploadStorePassword = System.getenv('OKRI_UPLOAD_STORE_PASSWORD')
            def uploadKeyAlias = System.getenv('OKRI_UPLOAD_KEY_ALIAS')
            def uploadKeyPassword = System.getenv('OKRI_UPLOAD_KEY_PASSWORD')
            if (![uploadStoreFile, uploadStorePassword, uploadKeyAlias, uploadKeyPassword].every { it }) {
                throw new GradleException('Missing OKRI Android release-signing environment')
            }
            storeFile file(uploadStoreFile)
            storePassword uploadStorePassword
            keyAlias uploadKeyAlias
            keyPassword uploadKeyPassword
        }
        debug {`;
  if (!source.includes(signingStart)) throw new Error("Unexpected Android signing configuration");
  source = source.replace(signingStart, releaseSigning);

  const debugSigning = "signingConfig signingConfigs.debug";
  const releaseSigningIndex = source.lastIndexOf(debugSigning);
  if (releaseSigningIndex < 0) throw new Error("Unexpected Android release build type");
  source = source.slice(0, releaseSigningIndex) + "signingConfig signingConfigs.release" + source.slice(releaseSigningIndex + debugSigning.length);
  writeFileSync(buildFile, source, "utf8");
}

console.log("Android release signing is configured for environment-provided credentials.");
