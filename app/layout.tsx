import SessionWrapper from "./clientLayout";
import "./globals.css";
import { ReactNode } from "react";
import type { Viewport } from "next";


export const metadata = {
  title: "Creative Studio - Amplify",
  description: "Media Orquestation",
};

/* Next injects `width=device-width, initial-scale=1` by default; this
 * declaration exists for `viewportFit`. The session pages are full-bleed
 * dark video stages, so painting under the notch and the home indicator is
 * what we want — the bottom-anchored chrome pays for it with `.pb-safe`.
 * `maximumScale` is deliberately not set: pinch-zoom stays available. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>
        <SessionWrapper>{children}</SessionWrapper>
      </body>
    </html>
  );
}
