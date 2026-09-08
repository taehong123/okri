import React from "react";
import { registerRootComponent } from "expo";
import { AppRoot } from "../App";
import { installPreview, previewSession } from "./mock";

installPreview();
const loadSession = async () => new URL(location.href).searchParams.has("login") ? null : previewSession;
registerRootComponent(() => <AppRoot loadSession={loadSession} />);
