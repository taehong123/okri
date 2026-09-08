import React from "react";
import { AppRoot } from "../App";
import { installPreview, previewSession } from "./mock";
installPreview();
const loadSession = async () => new URL(location.href).searchParams.has("login") ? null : previewSession;
export default function PreviewApp() { return <AppRoot loadSession={loadSession} />; }
