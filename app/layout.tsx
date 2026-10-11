import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "EventSync Pro",
  title: "Grevix EventSyncPro — Student Opportunity Aggregator & Application Tracker",
  description:
    "Student-centric aggregator for Unstop, Devfolio, SIH, and campus hackathons with offline Dexie sync and application tracking.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    title: "EventSync",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  other: { "mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // draw edge to edge in the installed app (notches, gesture bars)
  themeColor: "#0f172a",
  colorScheme: "dark",
};

/**
 * Chrome can fire `beforeinstallprompt` before React hydrates. Capture it immediately so the
 * "Install App (APK)" button (see hooks/useNetworkSync.ts) never misses it.
 */
const captureInstallPrompt = `
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  window.__deferredInstallPrompt = e;
});
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-IN" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: captureInstallPrompt }} />
      </head>
      <body className="min-h-screen bg-slate-950 font-sans text-slate-200 antialiased">
        {children}
      </body>
    </html>
  );
}
