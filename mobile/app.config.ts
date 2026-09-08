import type { ExpoConfig } from "expo/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import updatePolicy from "./release/update-policy.json";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const certificate = "./release/update-certificate.pem";
const hasCertificate = existsSync(resolve(__dirname, certificate));
if (projectId && updatePolicy.ota === "signed" && !hasCertificate) {
  throw new Error("Signed OTA requires the public update certificate");
}
const config: ExpoConfig = {
  name: "OKRI",
  slug: "okri",
  owner: process.env.EXPO_OWNER,
  version: "1.0.0",
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    enabled: Boolean(projectId) && updatePolicy.ota === "signed",
    ...(projectId ? { url: "https://u.expo.dev/" + projectId } : {}),
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
    useEmbeddedUpdate: true,
    ...(hasCertificate ? {
      codeSigningCertificate: certificate,
      codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
    } : {}),
  },
  scheme: "okri",
  orientation: "default",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "ai.okri.app",
    supportsTablet: true,
    usesAppleSignIn: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyAccessedAPITypes: [{
        NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
        NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
      }],
    },
  },
  android: {
    package: "ai.okri.app",
    allowBackup: false,
    predictiveBackGestureEnabled: true,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#FFFFFF",
    },
    blockedPermissions: ["android.permission.RECORD_AUDIO", "android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE", "android.permission.SYSTEM_ALERT_WINDOW"],
  },
  plugins: [
    "expo-secure-store", "expo-web-browser", "expo-localization", "expo-apple-authentication", "expo-asset", "@react-native-community/datetimepicker",
    ["expo-font", { fonts: ["./assets/PretendardVariable.ttf"] }],
    ["expo-splash-screen", { image: "./assets/icon.png", imageWidth: 80, backgroundColor: "#FFFFFF" }],
  ],
  extra: { ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;
