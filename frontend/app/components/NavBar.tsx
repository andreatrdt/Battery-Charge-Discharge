"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAppState } from "../lib/store";

const PRIMARY: [string, string][] = [
  ["/", "Market"],
  ["/replay", "Trading"],
  ["/validation", "Validation"],
  ["/data", "Audit"],
];

const TOOLS: [string, string][] = [
  ["/configure", "Battery Configuration"],
  ["/terminal", "Terminal"],
  ["/schedule", "Schedule"],
  ["/scenario", "Scenario Lab"],
  ["/backtest", "Backtest"],
  ["/lab", "Reserve & BM Lab"],
];

export function NavBar() {
  const pathname = usePathname();
  const { day, setDay, source, setSource, networkPolicy, setNetworkPolicy } = useAppState();
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  const toolActive = TOOLS.some(([href]) => href === pathname);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) setToolsOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const tab = (active: boolean) =>
    `whitespace-nowrap rounded px-3 py-1.5 text-sm transition-colors ${
      active
        ? "bg-kind-observed/15 text-kind-observed"
        : "text-terminal-muted hover:text-terminal-text hover:bg-terminal-border/40"
    }`;

  return (
    <header className="sticky top-0 z-20 border-b border-terminal-border bg-terminal-panel/95 backdrop-blur">
      <div className="mx-auto max-w-[1600px] px-4">
        <div className="flex items-center justify-between gap-4 py-2">
          <div className="flex items-center gap-4">
            <div className="flex items-baseline gap-2">
              <span className="text-kind-observed font-bold tracking-tight">GB BATTERY</span>
              <span className="text-terminal-muted text-[11px] hidden sm:inline">
                Trading &amp; Decision-Support Terminal
              </span>
            </div>
            <nav className="flex items-center gap-1">
              {PRIMARY.map(([href, label]) => (
                <Link key={href} href={href} className={tab(pathname === href)}>
                  {label}
                </Link>
              ))}
              <div className="relative" ref={toolsRef}>
                <button onClick={() => setToolsOpen((o) => !o)} className={tab(toolActive)}>
                  Tools ▾
                </button>
                {toolsOpen && (
                  <div className="absolute left-0 mt-1 w-52 rounded-md border border-terminal-border bg-terminal-panel py-1 shadow-xl">
                    {TOOLS.map(([href, label]) => (
                      <Link
                        key={href}
                        href={href}
                        onClick={() => setToolsOpen(false)}
                        className={`block px-3 py-1.5 text-sm ${
                          pathname === href
                            ? "text-kind-observed"
                            : "text-terminal-muted hover:bg-terminal-border/40 hover:text-terminal-text"
                        }`}
                      >
                        {label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </nav>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <label className="text-terminal-muted">Day</label>
            <input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
            />
            <label className="text-terminal-muted ml-1">Source</label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
              className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
            >
              <option value="synthetic">Synthetic</option>
              <option value="sample">Sample</option>
              <option value="elexon">Elexon</option>
            </select>
            {source === "elexon" && (
              <select
                value={networkPolicy}
                onChange={(e) => setNetworkPolicy(e.target.value as typeof networkPolicy)}
                className="bg-terminal-bg border border-terminal-border rounded px-2 py-1"
              >
                <option value="live_with_cache">Live + cache</option>
                <option value="cache_only">Cache only</option>
                <option value="live_only">Live only</option>
              </select>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
