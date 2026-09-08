import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const config: ExpoConfig = {
  name: "OKRI",
  slug: "okri",
  owner: process.env.EXPO_OWNER,
  version: "1.0.0",
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
