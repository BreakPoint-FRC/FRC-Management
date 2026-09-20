import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/components/auth/auth-provider";
import { ToastProvider } from "@/components/toast";
import { UnsavedChangesProvider } from "@/components/unsaved-changes";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

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
    // The inline script below may add data-theme before React hydrates. That
    // deliberate pre-paint mutation prevents a light/dark flash, but the
    // server cannot know localStorage and therefore cannot render the same
    // attribute. Limit hydration suppression to this root element only.
    <html lang="tr" suppressHydrationWarning>
      <head>
        {/* Runs before first paint so a stored light/dark preference never
            flashes the OS default first. See lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>
          <UnsavedChangesProvider>
            <AuthProvider>{children}</AuthProvider>
          </UnsavedChangesProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
