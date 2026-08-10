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
  const socialImage = new URL("/og-card.png", baseUrl).toString();

  return {
    metadataBase: baseUrl,
    title: "MOTION INK — VRM 트래킹 & 캐릭터 메이커",
    description:
      "VRM 캐릭터를 카메라로 움직이고 전신 PNG로 저장하거나, 도안 위에 직접 나만의 캐릭터를 그려보세요.",
    applicationName: "MOTION INK",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "MOTION INK — 움직이고, 그리고, 저장하세요",
      description: "브라우저에서 즐기는 VRM 모션 트래킹과 캐릭터 드로잉 랩",
      type: "website",
      url: baseUrl,
      images: [
        {
          url: socialImage,
          width: 1200,
          height: 630,
          alt: "MOTION INK VRM 트래킹과 캐릭터 드로잉 스튜디오",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "MOTION INK — 움직이고, 그리고, 저장하세요",
      description: "브라우저에서 즐기는 VRM 모션 트래킹과 캐릭터 드로잉 랩",
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
