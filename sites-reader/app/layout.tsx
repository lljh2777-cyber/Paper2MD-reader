import type { Metadata } from "next";
import "./globals.css";

const title = "Paper2MD Reader";
const description = "无需安装或登录，在浏览器中体验本地优先的 Paper2MD 论文阅读；本地文件不上传。";

const metadataBase = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://paper2md-reader.lljh2777.chatgpt.site"
);

export function generateMetadata(): Metadata {
  return {
    metadataBase,
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "Paper2MD Reader interface" }]
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og.png"]
    }
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="icon" href="data:," />
      </head>
      <body>{children}</body>
    </html>
  );
}
