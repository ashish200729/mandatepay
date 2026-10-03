import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const satoshi = localFont({
  src: "../../fonts/satoshi-variable.woff2",
  variable: "--font-satoshi",
  display: "swap",
  weight: "300 900",
});

const hedvig = localFont({
  src: "../../fonts/hedvig-letters-serif-latin.woff2",
  variable: "--font-hedvig",
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MandatePay — AI commerce, on your terms.",
  description:
    "AI commerce with human-controlled spending permissions. Discover the MandatePay concept: AI proposes, AgentGuard authorizes, PayPal executes.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${satoshi.variable} ${hedvig.variable}`}>
      <body>{children}</body>
    </html>
  );
}
