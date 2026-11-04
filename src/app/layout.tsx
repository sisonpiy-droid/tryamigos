import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import "./globals.css";

/* Kept in the repo (latin, variable weight, OFL) rather than fetched from
   Google at build time: a dev server with no internet failed every page. */
const sans = localFont({
  src: "./fonts/instrument-sans.woff2",
  weight: "400 600",
  variable: "--font-sans",
  display: "swap",
});

const serif = localFont({
  src: "./fonts/newsreader.woff2",
  weight: "300 500",
  variable: "--font-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MUSE — create anyone, talk to anyone",
  description: "AI personalities who remember you.",
  /* Added to an iPhone Home Screen, MUSE opens as an app -- and only then can
     Safari show it a notification. */
  appleWebApp: { capable: true, title: "MUSE", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0E0D12",
  // viewport-fit lets the safe-area insets in globals.css actually apply.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
