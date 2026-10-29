import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "NEXUS AI OS", template: "%s · NEXUS" },
  description: "A secure multi-model AI workspace and persistent agent operating system.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: `try{document.documentElement.dataset.theme=localStorage.getItem('nexus-theme')||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')}catch{}` }} /></head><body>{children}</body></html>;
}
