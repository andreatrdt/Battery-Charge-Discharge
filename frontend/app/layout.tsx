import type { Metadata } from "next";
import "./globals.css";
import { AppProvider } from "./lib/store";
import { NavBar } from "./components/NavBar";

export const metadata: Metadata = {
  title: "GB Battery Trading & Decision-Support Terminal",
  description:
    "GB battery trading and operational decision-support terminal: commercial imbalance, GB system imbalance and system frequency.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-terminal-bg text-terminal-text font-mono">
        <AppProvider>
          <NavBar />
          <main className="mx-auto max-w-[1600px] px-4 py-5">{children}</main>
        </AppProvider>
      </body>
    </html>
  );
}
