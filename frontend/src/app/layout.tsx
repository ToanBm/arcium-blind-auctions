import type { Metadata } from "next";
import { Urbanist, JetBrains_Mono, Outfit } from "next/font/google";
import Providers from "@/components/Providers";
import Nav from "@/components/Nav";
import "./globals.css";

const urbanist = Urbanist({
  variable: "--font-urbanist",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
});

export const metadata: Metadata = {
  title: "Blind Auctions — Arcium MPC",
  description: "Privacy-preserving Vickrey blind auctions on Solana",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${urbanist.variable} ${jetbrainsMono.variable} ${outfit.variable} antialiased min-h-screen text-white`}
      >
        {/* Background glow */}
        <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-doma-blue/5 rounded-full blur-[160px] -z-10 pointer-events-none" />
        <Providers>
          <Nav />
          <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
