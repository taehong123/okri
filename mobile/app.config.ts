import type { ExpoConfig } from "expo/config";

const androidVersionCode = Number.parseInt(process.env.OKRI_ANDROID_VERSION_CODE ?? "2", 10);
const iosBuildNumber = process.env.OKRI_IOS_BUILD_NUMBER ?? "1";
if (!Number.isInteger(androidVersionCode) || androidVersionCode < 1 || !/^\d+$/.test(iosBuildNumber)) {
  throw new Error("Store build numbers must be positive integers");
}
const config: ExpoConfig = {
  name: "OKRI",
  slug: "okri",
  version: "1.0.0",
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    // Store binaries are the only production update lane. No Expo account or OTA service is used.
    enabled: false,
    checkAutomatically: "NEVER",
    fallbackToCacheTimeout: 0,
    useEmbeddedUpdate: true,
  },
  scheme: "okri",
  orientation: "default",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: "ai.okri.app",
    buildNumber: iosBuildNumber,
    // The first store candidate is iPhone-only; iPad is a separately verified release target.
    supportsTablet: false,
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
    versionCode: androidVersionCode,
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
};
export default config;
