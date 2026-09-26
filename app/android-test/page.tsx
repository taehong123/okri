import type { Metadata } from "next";
import AndroidTestPage from "./android-test-page";

export const metadata: Metadata = {
  title: "OKRI Android testing",
  description: "Apply to test the OKRI Android app.",
};

export default function Page() { return <AndroidTestPage />; }
