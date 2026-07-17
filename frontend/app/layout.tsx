import type { Metadata } from "next";
import "./globals.css";
import { AppProvider } from "./lib/store";
import { NavBar } from "./components/NavBar";

export const metadata: Metadata = {
  title: "GB Battery Co-Optimisation Terminal",
  description:
    "Research & decision-support tool for GB battery charge/discharge co-optimisation across wholesale, balancing services and imbalance value.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-terminal-bg text-terminal-text font-mono">
        <AppProvider>
          <NavBar />
          <main className="mx-auto max-w-[1500px] px-4 py-6">{children}</main>
          <footer className="mx-auto max-w-[1500px] px-4 py-8 text-xs text-terminal-muted border-t border-terminal-border mt-8">
            <p>
              <strong>Disclaimer.</strong> Research & decision-support only. This is not a live
              trading or asset-control system. It submits no market orders and claims no proprietary
              data access. Public data: Elexon (BMRS) &amp; NESO open licences. No EPEX order-book
              data is included or redistributed.
            </p>
          </footer>
        </AppProvider>
      </body>
    </html>
  );
}
