import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const configuredOrigin = process.env.SITE_ORIGIN?.trim().replace(/\/$/, "");
const siteOrigin = configuredOrigin && /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(configuredOrigin)
  ? configuredOrigin
  : undefined;
const socialImage = siteOrigin ? `${siteOrigin}/og-v2.png` : undefined;

export const metadata: Metadata = {
  metadataBase: siteOrigin ? new URL(siteOrigin) : undefined,
  title: "骏骏订单｜多渠道采购转卖管理",
  description: "贯穿采购上报、订单审核、收货入库、售出发货与利润核算的轻量级 H5 管理系统。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  openGraph: { title: "骏骏订单", description: "采购、入库、售出、利润，全链路一手掌握", images: socialImage ? [socialImage] : undefined },
  twitter: { card: "summary_large_image", title: "骏骏订单", description: "采购、入库、售出、利润，全链路一手掌握", images: socialImage ? [socialImage] : undefined },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
