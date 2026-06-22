import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Control Console",
  description: "Realtime local console for Agent Control runs and workers."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
