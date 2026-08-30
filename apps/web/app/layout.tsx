import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { RegisterServiceWorker } from "./register-sw";
import { AuthProvider } from "@/components/auth/auth-provider";

export const metadata: Metadata = {
  title: "BreakPoint",
  description: "FRC team management",
  manifest: "/manifest.webmanifest",
  applicationName: "BreakPoint",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "BreakPoint",
    statusBarStyle: "black-translucent",
  },
};

// Next 14 requires themeColor here rather than in `metadata`.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    // lang="tr": every string a user reads here is Turkish, including the
    // messages the API sends back.
    <html lang="tr">
      <body>
        <AuthProvider>{children}</AuthProvider>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
