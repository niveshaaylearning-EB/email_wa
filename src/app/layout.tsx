import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/app/providers";
import { getAppSettings } from "@/lib/services/settings";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Niveshaay Communication Center", template: "%s · Niveshaay CC" },
  description: "Category-driven email and WhatsApp communications for Niveshaay clients.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  let brand = { primaryColor: "#1E3A5F", accentColor: "#0F8B6E" };
  try {
    brand = (await getAppSettings()).branding;
  } catch {
    // DB unavailable (e.g. first boot) — fall back to default brand tokens.
  }
  // Brand colours are set as CSS variables on <html> (not a <style> tag in <head>): browser
  // extensions such as ad-blockers inject their own <style> into <head>, which caused a
  // hydration mismatch loop on the login page.
  const brandVars = { "--brand": brand.primaryColor, "--brand-accent": brand.accentColor } as React.CSSProperties;
  return (
    <html lang="en-IN" suppressHydrationWarning style={brandVars} className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
