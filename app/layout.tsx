import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import "./touch-forms.css";

const iosFocusZoomScript = `
(() => {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!isIOS) return;

  document.documentElement.classList.add("ios-device");
  const viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) return;

  const content = viewport.getAttribute("content") || "width=device-width, initial-scale=1";
  if (!/maximum-scale=/.test(content.replace(/ /g, ""))) {
    viewport.setAttribute("content", content + ", maximum-scale=1");
  }
})();
`;

const configuredOrigin = process.env.SITE_ORIGIN?.trim().replace(/\/$/, "");
const siteOrigin = configuredOrigin && /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(configuredOrigin)
  ? configuredOrigin
  : undefined;
const socialImage = siteOrigin ? `${siteOrigin}/og-v2.png` : undefined;

export const metadata: Metadata = {
  metadataBase: siteOrigin ? new URL(siteOrigin) : undefined,
  title: "鸿运采购｜多渠道采购转卖管理",
  description: "贯穿采购上报、订单审核、收货入库、售出发货与利润核算的轻量级 H5 管理系统。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: { title: "鸿运采购", description: "采购、入库、售出、利润，全链路一手掌握", images: socialImage ? [socialImage] : undefined },
  twitter: { card: "summary_large_image", title: "鸿运采购", description: "采购、入库、售出、利润，全链路一手掌握", images: socialImage ? [socialImage] : undefined },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <Script id="ios-focus-zoom" strategy="beforeInteractive">
          {iosFocusZoomScript}
        </Script>
      </body>
    </html>
  );
}
