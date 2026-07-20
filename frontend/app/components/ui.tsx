"use client";

import type { ActionLabel, DataKind } from "../lib/api";
import { ACTION_COLOR, KIND_COLOR } from "../lib/api";

export function Panel({ title, children, right }: { title?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-terminal-border bg-terminal-panel">
      {title && (
        <div className="flex items-center justify-between border-b border-terminal-border px-4 py-2">
          <h2 className="text-sm font-semibold text-terminal-text">{title}</h2>
          {right}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-terminal-muted">{label}</div>
      <div className="tabular text-xl font-semibold" style={{ color: accent }}>
        {value}
      </div>
      {sub && <div className="text-xs text-terminal-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/** Compact KPI tile: label, primary value with a unit, and an optional badge/sub. */
export function Kpi({
  label,
  value,
  unit,
  sub,
  accent,
  badge,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: React.ReactNode;
  accent?: string;
  badge?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-terminal-muted">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="tabular text-lg font-semibold leading-none" style={{ color: accent }}>
          {value}
        </span>
        {unit && <span className="text-[11px] text-terminal-muted">{unit}</span>}
      </div>
      {badge && <div className="mt-1">{badge}</div>}
      {sub && <div className="mt-0.5 text-[11px] tabular text-terminal-muted">{sub}</div>}
    </div>
  );
}

/** Restrained tab bar for advanced/secondary sections. */
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: string[];
  active: string;
  onChange: (t: string) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-terminal-border">
      {tabs.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`-mb-px border-b-2 px-3 py-1.5 text-xs transition-colors ${
            active === t
              ? "border-kind-observed text-kind-observed"
              : "border-transparent text-terminal-muted hover:text-terminal-text"
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

export function KindBadge({ kind }: { kind: DataKind }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase"
      style={{ color: KIND_COLOR[kind], backgroundColor: `${KIND_COLOR[kind]}1f` }}
      title={`This value is ${kind} data`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: KIND_COLOR[kind] }} />
      {kind}
    </span>
  );
}

export function ActionBadge({ action }: { action: ActionLabel }) {
  const color = ACTION_COLOR[action];
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-bold"
      style={{ color, backgroundColor: `${color}1f` }}
    >
      {action}
    </span>
  );
}

export function Field({
  label,
  value,
  onChange,
  step = 1,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-terminal-muted">{label}</span>
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="tabular bg-terminal-bg border border-terminal-border rounded px-2 py-1.5 text-terminal-text focus:border-kind-observed outline-none"
      />
      {hint && <span className="text-[10px] text-terminal-muted">{hint}</span>}
    </label>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <div className="text-sm text-terminal-muted animate-pulse py-8 text-center">{label}</div>;
}

export function ErrorNote({ error }: { error: string }) {
  return (
    <div className="rounded border border-action-discharge/40 bg-action-discharge/10 px-3 py-2 text-sm text-action-discharge">
      {error}
    </div>
  );
}

export function Disclaimer({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-kind-estimated/30 bg-kind-estimated/10 px-3 py-2 text-xs text-kind-estimated">
      {children}
    </div>
  );
}
