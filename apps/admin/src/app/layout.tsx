import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
const satoshi = localFont({
  src: "../../../web/fonts/satoshi-variable.woff2",
  variable: "--font-satoshi",
  display: "swap",
  weight: "300 900",
});
const hedvig = localFont({
  src: "../../../web/fonts/hedvig-letters-serif-latin.woff2",
  variable: "--font-hedvig",
  display: "swap",
  weight: "400",
});
export const metadata: Metadata = {
  title: "MandatePay Admin",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${satoshi.variable} ${hedvig.variable}`}>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:block focus:p-4">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
