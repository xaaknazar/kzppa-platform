import type { Metadata } from "next";
import { Golos_Text, PT_Serif } from "next/font/google";
import "./globals.css";

const golos = Golos_Text({ subsets: ["latin", "cyrillic", "cyrillic-ext"], variable: "--font-golos", display: "swap" });
const ptSerif = PT_Serif({ subsets: ["latin", "cyrillic", "cyrillic-ext"], weight: ["400", "700"], variable: "--font-ptserif", display: "swap" });

export const metadata: Metadata = {
  title: { default: "КЗППА РКА", template: "%s — КЗППА РКА" },
  description: "Платформа Комиссии по защите профессиональных прав адвокатов Республиканской коллегии адвокатов",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${golos.variable} ${ptSerif.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
