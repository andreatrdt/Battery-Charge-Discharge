"use client";

/** Operational badges: provenance, position direction and status. No teaching. */

const PROV_COLOR: Record<string, string> = {
  observed: "#38bdf8",
  published_forecast: "#a78bfa",
  model_forecast: "#c084fc",
  reconstructed: "#f59e0b",
  synthetic: "#64748b",
  sample: "#64748b",
  assumed: "#f472b6",
  perfect_foresight: "#fbbf24",
  paper_trade: "#34d399",
  paper_day_ahead_plan: "#34d399",
  user_supplied: "#34d399",
  experimental: "#fb7185",
  unavailable: "#7c8896",
};

export function ProvBadge({ p }: { p: string }) {
  const color = PROV_COLOR[p] ?? "#7c8896";
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase whitespace-nowrap"
      style={{ color, backgroundColor: `${color}1f` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {p.replaceAll("_", " ")}
    </span>
  );
}

// Directional (not good/bad) colours: LONG / SHORT / BALANCED / UNAVAILABLE.
const DIR_COLOR: Record<string, string> = {
  LONG: "#38bdf8",
  "GB SYSTEM LONG": "#38bdf8",
  SHORT: "#f59e0b",
  "GB SYSTEM SHORT": "#f59e0b",
  BALANCED: "#7c8896",
  UNAVAILABLE: "#7c8896",
};

export function DirectionBadge({ dir }: { dir: string | null | undefined }) {
  const label = dir ?? "UNAVAILABLE";
  const color = DIR_COLOR[label] ?? "#7c8896";
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tabular whitespace-nowrap"
      style={{ color, backgroundColor: `${color}1f` }}
    >
      {label}
    </span>
  );
}

const STATUS_COLOR: Record<string, string> = {
  settled: "#38bdf8",
  confirmed: "#34d399",
  paper: "#34d399",
  pending: "#f59e0b",
  estimated: "#f59e0b",
  simulated: "#a78bfa",
  unavailable: "#7c8896",
  inconsistent: "#ef4444",
  rejected: "#ef4444",
};

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "#7c8896";
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase whitespace-nowrap"
      style={{ color, backgroundColor: `${color}1f` }}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
