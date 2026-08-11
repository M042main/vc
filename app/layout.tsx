import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:5173";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og-virtual-creator.png", baseUrl).toString();

  return {
    metadataBase: baseUrl,
    title: "Virtual Creator — VRM 트래킹 & 캐릭터 메이커",
    description:
      "VRM과 직접 그린 캐릭터를 카메라 또는 프리셋 모션으로 움직이고, PiP·크로마키 무대와 전신 PNG·WebM 저장을 활용하세요.",
    applicationName: "Virtual Creator",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "Virtual Creator — 움직이고, 그리고, 저장하세요",
      description: "브라우저에서 즐기는 VRM 트래킹, PiP와 캐릭터 애니메이션 랩",
      type: "website",
      url: baseUrl,
      images: [
        {
          url: socialImage,
          width: 1731,
          height: 909,
          alt: "Virtual Creator VRM 트래킹과 직접 그린 캐릭터 스튜디오",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Virtual Creator — 움직이고, 그리고, 저장하세요",
      description: "브라우저에서 즐기는 VRM 트래킹, PiP와 캐릭터 애니메이션 랩",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
