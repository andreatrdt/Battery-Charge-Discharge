"use client";

/**
 * Learning-mode helpers. Learning mode changes explanation density and visual
 * presentation only — it never changes any calculation.
 */

import { useState } from "react";
import { useAppState } from "../lib/store";

/** Block-level explainer, rendered only when Learning mode is ON. */
export function Learn({ title, children }: { title?: string; children: React.ReactNode }) {
  const { learning } = useAppState();
  if (!learning) return null;
  return (
    <div className="rounded border border-kind-forecast/30 bg-kind-forecast/5 px-3 py-2 text-xs text-terminal-text/90">
      {title && <div className="mb-1 font-semibold text-kind-forecast">📘 {title}</div>}
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}

/** Inline tooltip trigger; always available, more prominent in Learning mode. */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        onBlur={() => setOpen(false)}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-terminal-muted/50 text-[9px] text-terminal-muted hover:text-kind-forecast hover:border-kind-forecast align-middle"
        aria-label="Explain"
      >
        i
      </button>
      {open && (
        <span className="absolute left-1/2 z-30 mt-1 w-64 -translate-x-1/2 rounded border border-terminal-border bg-terminal-panel p-2 text-[11px] leading-snug text-terminal-text shadow-xl">
          {text}
        </span>
      )}
    </span>
  );
}

/** Provenance badge — every important value states what kind of number it is. */
const PROV_STYLE: Record<string, { color: string; label: string; tip: string }> = {
  observed: { color: "#38bdf8", label: "observed", tip: "A realised value from a public source." },
  published_forecast: { color: "#a78bfa", label: "published forecast", tip: "A third-party forecast with a real publication time." },
  model_forecast: { color: "#c084fc", label: "model forecast", tip: "Produced by this app's own point-in-time model." },
  reconstructed: { color: "#f59e0b", label: "reconstructed", tip: "The publication time is an assumption (e.g. MID availability = period end + 10 min), not a recorded timestamp." },
  synthetic: { color: "#64748b", label: "synthetic", tip: "Generated demonstration data — not from any market." },
  assumed: { color: "#f472b6", label: "assumed", tip: "A user-supplied or default assumption." },
  perfect_foresight: { color: "#fbbf24", label: "perfect foresight", tip: "Uses the realised path — a benchmark, not a tradable strategy." },
  paper_trade: { color: "#34d399", label: "paper trade", tip: "Simulated execution; no order was submitted anywhere." },
  experimental: { color: "#fb7185", label: "experimental", tip: "Assumption-based research feature; excluded from credible headline results." },
};

export function ProvBadge({ p }: { p: string }) {
  const s = PROV_STYLE[p] ?? { color: "#7c8896", label: p, tip: "" };
  return (
    <span
      title={s.tip}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase whitespace-nowrap"
      style={{ color: s.color, backgroundColor: `${s.color}1f` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
      {s.label}
    </span>
  );
}
