import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";
import "./workspace-design.css";
import "./item-editor.css";
import "./document-view.css";
import "./gantt-view.css";
import "./pwa.css";
import { themeBootstrapScript, themeCss } from "@/lib/themes";
import { appInstallBootstrapScript } from "@/lib/app-install";
import { PRODUCT_NAME, PUBLIC_APP_URL } from "@/lib/brand";
import { BRAND_ASSET_ROOT } from "@/lib/brand-artwork";

const bootstrapScript = themeBootstrapScript + appInstallBootstrapScript + `(() => {
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const path = "/api/bootstrap?date=" + encodeURIComponent(date);
  window.__OKRI_BOOTSTRAP_REQUEST__ = {
    path,
    request: fetch(path, { cache: "no-store", credentials: "same-origin" }).then(async (response) => ({
      ok: response.ok,
      status: response.status,
      data: await response.json().catch(() => null),
    })),
  };
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => undefined);
    }, { once: true });
  }
})();`;

export async function generateMetadata(): Promise<Metadata> {
  const base = new URL(PUBLIC_APP_URL);

  return {
    metadataBase: base,
    applicationName: "OKRI",
    title: "OKRI - 목표를 오늘의 실행으로",
    description: "Objective부터 Task까지 연결하고 MCP, 데일리 실행과 Routine을 관리하는 워크스페이스",
    icons: {
      icon: `${BRAND_ASSET_ROOT}/okri-icon.svg`,
      shortcut: `${BRAND_ASSET_ROOT}/okri-icon.svg`,
      apple: `${BRAND_ASSET_ROOT}/apple-touch-icon.png`,
    },
    openGraph: {
      title: `${PRODUCT_NAME} - 목표를 오늘의 실행으로`,
      description: "OKR 계층, Project, Task 데이터베이스와 Routine을 MCP 중심으로 관리합니다.",
      images: [{ url: `${BRAND_ASSET_ROOT}/okri-social.png`, width: 1200, height: 630, alt: PRODUCT_NAME }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${PRODUCT_NAME} - 목표를 오늘의 실행으로`,
      description: "OKR 계층, Project, Task 데이터베이스와 Routine을 MCP 중심으로 관리합니다.",
      images: [`${BRAND_ASSET_ROOT}/okri-social.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/* Keep the manifest in the real head after hydration, not a streamed metadata container. */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <style id="okri-theme-colors" dangerouslySetInnerHTML={{ __html: themeCss }} />
        <script dangerouslySetInnerHTML={{ __html: bootstrapScript }} />
      </head>
      <body>
        {children}
      </body>
    </html>
  );
}
