"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppState } from "../lib/store";

const LINKS: [string, string][] = [
  ["/", "Market"],
  ["/configure", "Battery"],
  ["/replay", "Replay & Live"],
  ["/validation", "Forecast Validation"],
  ["/terminal", "Terminal"],
  ["/schedule", "Schedule"],
  ["/scenario", "Scenario Lab"],
  ["/lab", "Reserve & BM Lab"],
  ["/backtest", "Backtest"],
  ["/data", "Data"],
  ["/methodology", "Methodology"],
];

export function NavBar() {
  const pathname = usePathname();
  const { day, setDay, source, setSource, networkPolicy, setNetworkPolicy, learning, setLearning } =
    useAppState();
  return (
    <header className="sticky top-0 z-20 border-b border-terminal-border bg-terminal-panel/95 backdrop-blur">
      <div className="mx-auto max-w-[1500px] px-4">
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2">
            <span className="text-kind-observed font-bold tracking-tight">GB BATTERY</span>
            <span className="text-terminal-muted text-xs hidden sm:inline">Co-Optimisation Terminal</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={() => setLearning(!learning)}
              title="Learning mode adds explanations and examples. It never changes any calculation."
              className={`rounded border px-2 py-1 ${
                learning
                  ? "border-kind-forecast/60 text-kind-forecast bg-kind-forecast/10"
                  : "border-terminal-border text-terminal-muted hover:text-terminal-text"
              }`}
            >
              📘 Learning: {learning ? "ON" : "OFF"}
            </button>
            <label className="text-terminal-muted ml-2">Day</label>
            <input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
            />
            <label className="text-terminal-muted ml-2">Source</label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
              title="One global source for every page. Synthetic and Frozen sample are offline; Elexon fetches real public data."
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
            >
              <option value="synthetic">Synthetic</option>
              <option value="sample">Frozen sample</option>
              <option value="elexon">Elexon (public data)</option>
            </select>
            {source === "elexon" && (
              <select
                value={networkPolicy}
                onChange={(e) => setNetworkPolicy(e.target.value as typeof networkPolicy)}
                title="Elexon network policy. Cache-only never makes a network request."
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
              >
                <option value="live_with_cache">Live + cache fallback</option>
                <option value="cache_only">Cache only</option>
                <option value="live_only">Live only</option>
              </select>
            )}
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto pb-1 scroll-x">
          {LINKS.map(([href, label]) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`whitespace-nowrap rounded px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-kind-observed/15 text-kind-observed"
                    : "text-terminal-muted hover:text-terminal-text hover:bg-terminal-border/40"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
