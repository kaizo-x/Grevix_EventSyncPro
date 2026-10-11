import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "EventSync",
  title: "EventSync India — Tech & Campus Events",
  description:
    "Discover hackathons, workshops and campus fests across India. Check in even when the network drops: nothing is ever lost.",
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
