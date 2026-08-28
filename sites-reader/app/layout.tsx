import type { Metadata } from "next";
import "./globals.css";

const title = "After-MinerU by Paper2MD";
const description = "在浏览器内转换、修复、临时阅读并导出 MinerU / PDF 论文结果；独立第三方工具，不提供云端论文库。";

const metadataBase = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://after-mineru.lljh2777.chatgpt.site"
);

export function generateMetadata(): Metadata {
  return {
    metadataBase,
    title,
    description,
    openGraph: {
      title,
      description,
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "After-MinerU Reader interface" }]
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
