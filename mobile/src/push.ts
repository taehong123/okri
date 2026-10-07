import { useEffect, type RefObject } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import type { NavigationContainerRef } from "@react-navigation/native";
import type { Language } from "./i18n";
import type { Routes } from "./types";

const ENABLED_KEY = "okri.native.push-enabled";
const TOKEN_KEY = "okri.native.push-token";
const CHANNEL_ID = "work-updates";
const isNativePlatform = Platform.OS === "android" || Platform.OS === "ios";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

function appId() {
  return Application.applicationId || (Platform.OS === "android" ? "ai.okri.mobile" : "ai.okri.app");
}

function granted(status: Notifications.NotificationPermissionsStatus) {
  if (Platform.OS !== "ios") return status.granted;
  return status.ios?.status === Notifications.IosAuthorizationStatus.AUTHORIZED
    || status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
    || status.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL;
}

async function ensureAndroidChannel() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "Work updates",
    description: "Assignments and daily work summaries",
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 200],
    lightColor: "#525252",
  });
}

async function nativeToken() {
  await ensureAndroidChannel();
  const token = await Notifications.getDevicePushTokenAsync();
  if (typeof token.data !== "string" || !token.data) throw new Error("Push token is unavailable");
  return token.data;
}

async function sendRegistration(api: Api, token: string, locale: Language) {
  await api("/api/mobile/v1/notifications/devices", {
    method: "POST",
    body: JSON.stringify({
      token,
      platform: Platform.OS,
      appId: appId(),
      locale,
      environment: __DEV__ ? "development" : "production",
    }),
  });
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function pushPermissionState() {
  if (!isNativePlatform) return "denied" as const;
  const permission = await Notifications.getPermissionsAsync();
  return granted(permission) ? "granted" as const : permission.canAskAgain ? "prompt" as const : "denied" as const;
}

export async function enablePush(api: Api, locale: Language) {
  if (!isNativePlatform) return { enabled: false, denied: true };
  await ensureAndroidChannel();
  let permission = await Notifications.getPermissionsAsync();
  if (!granted(permission) && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
  if (!granted(permission)) return { enabled: false, denied: true };
  await sendRegistration(api, await nativeToken(), locale);
  await AsyncStorage.setItem(ENABLED_KEY, "true");
  return { enabled: true, denied: false };
}

export async function disablePush(api: Api) {
  if (!isNativePlatform) return;
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (token) await api("/api/mobile/v1/notifications/devices", {
    method: "DELETE",
    body: JSON.stringify({ token, platform: Platform.OS, appId: appId() }),
  });
  await Promise.all([AsyncStorage.removeItem(ENABLED_KEY), SecureStore.deleteItemAsync(TOKEN_KEY)]);
}

export function usePushRegistration(api: Api, locale: Language, signedIn: boolean) {
  useEffect(() => {
    if (!signedIn || !isNativePlatform) return;
    let active = true;
    async function refresh() {
      if ((await AsyncStorage.getItem(ENABLED_KEY)) !== "true" || !active) return;
      if ((await pushPermissionState()) !== "granted" || !active) return;
      await sendRegistration(api, await nativeToken(), locale);
    }
    void refresh().catch(() => undefined);
    const subscription = Notifications.addPushTokenListener(token => {
      if (active && typeof token.data === "string") void sendRegistration(api, token.data, locale).catch(() => undefined);
    });
    return () => { active = false; subscription.remove(); };
  }, [api, locale, signedIn]);
}

export function useNotificationNavigation(ref: RefObject<NavigationContainerRef<Routes> | null>, signedIn: boolean) {
  useEffect(() => {
    if (!signedIn || !isNativePlatform) return;
    const handled = new Set<string>();
    async function open(response: Notifications.NotificationResponse | null | undefined) {
      if (!response || handled.has(response.notification.request.identifier)) return;
      for (let attempt = 0; attempt < 20 && !ref.current?.isReady(); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
      if (!ref.current?.isReady()) return;
      handled.add(response.notification.request.identifier);
      const itemId = response.notification.request.content.data?.itemId;
      if (typeof itemId === "string" && itemId) ref.current.navigate("Item", { id: itemId });
      else ref.current.navigate("Notifications");
    }
    void Notifications.getLastNotificationResponseAsync().then(response => open(response));
    const subscription = Notifications.addNotificationResponseReceivedListener(response => { void open(response); });
    return () => subscription.remove();
  }, [ref, signedIn]);
}
