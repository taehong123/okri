import type { Metadata } from "next";
import AndroidTestStatusPage from "./status-page";

export const metadata: Metadata = { title: "My Android test | OKRI", robots: { index: false, follow: false } };
export default function Page() { return <AndroidTestStatusPage />; }
