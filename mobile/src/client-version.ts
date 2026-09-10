import * as Application from "expo-application";
import Constants from "expo-constants";
import { Platform } from "react-native";

export function clientHeaders() {
  return {
    "X-OKRI-Client": "native",
    "X-OKRI-Platform": Platform.OS,
    "X-OKRI-App-Version": Application.nativeApplicationVersion || Constants.expoConfig?.version || "1.0.0",
    "X-OKRI-App-Build": Application.nativeBuildVersion || "development",
  };
}
