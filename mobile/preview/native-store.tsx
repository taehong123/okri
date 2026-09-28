// Simulator-only store media entry. Never imported by the store binary.
import React from "react";
import { registerRootComponent } from "expo";
import AsyncStorage from "@react-native-async-storage/async-storage";

const previewUrl = new URL("https://preview.invalid/?lang=ko&theme=white");
(globalThis as any).location = { href: previewUrl.href, origin: previewUrl.origin };
(globalThis as any).localStorage = { setItem: () => undefined };
if (!Response.json) {
  Response.json = (data, init) => new Response(JSON.stringify(data), {
    ...init, headers: { "Content-Type": "application/json", ...init?.headers },
  });
}
const { installPreview, previewSession } = require("./mock");
installPreview();
const { AppRoot } = require("../App");
const loadSession = async () => previewSession;
const preferences = AsyncStorage.multiSet([
  ["okri.native.language", "ko"], ["okri.native.theme", "white"],
]);
function StoreMedia() {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => { void preferences.then(() => setReady(true)); }, []);
  return ready ? <AppRoot loadSession={loadSession} /> : null;
}
registerRootComponent(StoreMedia);
