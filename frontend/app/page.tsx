"use client";

import { useEffect, useMemo, useState } from "react";
import {
  api,
  gbp,
  num,
  type BalanceSnapshot,
  type CommercialPosition,
  type MarketSnapshot,
} from "./lib/api";
import { useAppState } from "./lib/store";
import { MultiSeriesChart } from "./components/charts";
import { DirectionBadge, ProvBadge, StatusBadge } from "./components/badges";
import { ErrorNote, Kpi, Panel, Spinner } from "./components/ui";

interface FreqDay {
  provenance: string;
  periods: { settlement_period: number; mean_frequency_hz: number | null }[];
}

function signed(x: number | null | undefined, dp = 1): string {
  if (x === null || x === undefined) return "—";
  const s = x.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return x > 0 ? `+${s}` : s;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toISOString().slice(11, 16)} UTC`;
}

function lastReplayId(): string | null {
  try {
    const raw = localStorage.getItem("gbb_last_replay");
    if (!raw) return null;
    return (JSON.parse(raw) as { replay_id?: string }).replay_id ?? null;
  } catch {
    return null;
  }
}

export default function MarketPage() {
  const { day, source, networkPolicy } = useAppState();
  const [sp, setSp] = useState(36);
  const [balance, setBalance] = useState<BalanceSnapshot | null>(null);
  const [snap, setSnap] = useState<MarketSnapshot | null>(null);
  const [freqDay, setFreqDay] = useState<FreqDay | null>(null);
  const [rightAxis, setRightAxis] = useState<"frequency" | "price">("frequency");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const replayId = lastReplayId();
  const nSp = snap?.periods.length || 48;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api.balance(day, sp, source, networkPolicy, replayId),
      api.snapshot(day, source, networkPolicy).catch(() => null),
      api.frequencyDay(day, source, networkPolicy).catch(() => null),
    ])
      .then(([b, s, f]) => {
        if (!alive) return;
        setBalance(b);
        setSnap(s);
        setFreqDay(f as FreqDay | null);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [day, sp, source, networkPolicy, replayId]);

  const chartData = useMemo(() => {
    const freqBySp = new Map(
      (freqDay?.periods || []).map((p) => [p.settlement_period, p.mean_frequency_hz]),
    );
    return (snap?.periods || []).map((p) => ({
      sp: p.settlement_period as number,
      niv: p.net_imbalance_volume as number | null,
      freq: (freqBySp.get(p.settlement_period as number) ?? null) as number | null,
      price: p.system_price as number | null,
    }));
  }, [snap, freqDay]);

  const sys = balance?.system ?? null;
  const freq = balance?.frequency ?? null;
  const comm = balance?.commercial ?? null;
  const batt = balance?.battery ?? null;
  const ctx = balance?.context ?? null;
  const commAvailable = comm != null && comm.status !== "unavailable";

  const modeLabel =
    source === "elexon" ? "Elexon" : source === "sample" ? "Sample" : "Synthetic";

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border border-terminal-border bg-terminal-panel px-4 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <span className="text-sm font-semibold text-terminal-text">Market</span>
          <span><span className="text-terminal-muted">Date</span> {ctx?.actual_data_date ?? day}</span>
          <span className="text-terminal-muted">
            SP <span className="tabular font-semibold text-kind-observed">{sp}</span>/{nSp}
          </span>
          <span>
            <span className="text-terminal-muted">Source</span>{" "}
            {ctx && ctx.requested_source !== ctx.actual_source ? (
              <span className="text-kind-estimated">{ctx.requested_source}→{ctx.actual_source}</span>
            ) : (
              modeLabel
            )}
          </span>
          <span className="text-terminal-muted">
            {ctx?.network_used ? "live" : "offline"}
            {ctx?.cache_used ? " · cache" : ""}
          </span>
          <span>
            <span className="text-terminal-muted">Published</span> {fmtTime(sys?.published_at)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSp((v) => Math.max(1, v - 1))}
            className="rounded border border-terminal-border px-2 py-0.5 hover:bg-terminal-border/40"
          >
            ◀
          </button>
          <input
            type="number"
            min={1}
            max={nSp}
            value={sp}
            onChange={(e) => setSp(Math.min(nSp, Math.max(1, parseInt(e.target.value || "1", 10))))}
            className="w-14 bg-terminal-bg border border-terminal-border rounded px-2 py-0.5 tabular text-center"
          />
          <button
            onClick={() => setSp((v) => Math.min(nSp, v + 1))}
            className="rounded border border-terminal-border px-2 py-0.5 hover:bg-terminal-border/40"
          >
            ▶
          </button>
        </div>
      </div>

      {ctx?.warnings && ctx.warnings.length > 0 && (
        <ul className="rounded border border-kind-estimated/40 bg-kind-estimated/10 px-3 py-1.5 text-[11px] text-kind-estimated">
          {ctx.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {error && <ErrorNote error={error} />}
      {loading && !balance && <Spinner label="Loading balance…" />}

      {balance && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Kpi
              label="GB System"
              value={sys?.direction ? sys.direction.replace("GB SYSTEM ", "") : "—"}
              badge={<DirectionBadge dir={sys?.direction} />}
            />
            <Kpi
              label="Net Imbalance Volume"
              value={signed(sys?.net_imbalance_volume_mwh, 0)}
              unit="MWh"
            />
            <Kpi
              label="System Frequency"
              value={freq?.latest_frequency_hz != null ? num(freq.latest_frequency_hz, 3) : "—"}
              unit="Hz"
              sub={
                freq?.deviation_from_50_hz != null
                  ? `${signed(freq.deviation_from_50_hz, 3)} vs 50`
                  : freq?.warnings?.length
                    ? "Frequency unavailable"
                    : undefined
              }
            />
            <Kpi
              label="System Price"
              value={sys?.system_price_gbp_per_mwh != null ? num(sys.system_price_gbp_per_mwh, 2) : "—"}
              unit="£/MWh"
            />
            <Kpi
              label="Commercial Position"
              value={commAvailable ? (comm?.direction ?? "—") : "UNAVAILABLE"}
              badge={commAvailable ? <DirectionBadge dir={comm?.direction} /> : undefined}
            />
            <Kpi
              label="Commercial Imbalance"
              value={commAvailable ? signed(comm?.commercial_imbalance_mwh, 2) : "—"}
              unit={commAvailable ? "MWh" : undefined}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            {/* Panel A — GB System */}
            <Panel
              title="GB System — NIV & frequency"
              right={
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="text-terminal-muted">right axis</span>
                  {(["frequency", "price"] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setRightAxis(k)}
                      className={`rounded border px-1.5 py-0.5 ${
                        rightAxis === k
                          ? "border-kind-observed/60 text-kind-observed"
                          : "border-terminal-border text-terminal-muted"
                      }`}
                    >
                      {k === "frequency" ? "Hz" : "£/MWh"}
                    </button>
                  ))}
                </div>
              }
            >
              <MultiSeriesChart
                data={chartData}
                height={260}
                zeroLine
                leftLabel="NIV MWh"
                rightLabel={rightAxis === "frequency" ? "Hz" : "£/MWh"}
                xRefLine={{ x: sp, label: "SP", color: "#38bdf8" }}
                series={
                  rightAxis === "frequency"
                    ? [
                        { key: "niv", name: "NIV (MWh)", color: "#f59e0b", type: "bar", yAxis: "left" },
                        { key: "freq", name: "Frequency (Hz)", color: "#a78bfa", yAxis: "right" },
                      ]
                    : [
                        { key: "niv", name: "NIV (MWh)", color: "#f59e0b", type: "bar", yAxis: "left" },
                        { key: "price", name: "System price (£/MWh)", color: "#38bdf8", yAxis: "right", dashed: true },
                      ]
                }
              />
            </Panel>

            {/* Panel B — Commercial Position */}
            <Panel
              title="Commercial Position"
              right={comm ? <StatusBadge status={comm.status} /> : undefined}
            >
              {commAvailable && comm ? (
                <CommercialLadder comm={comm} socMwh={batt?.soc_mwh ?? null} />
              ) : (
                <div className="flex h-[260px] flex-col items-center justify-center gap-1 text-sm text-terminal-muted">
                  <span>Commercial position unavailable</span>
                  {comm?.unavailable_reason && (
                    <span className="max-w-xs text-center text-[11px]">{comm.unavailable_reason}</span>
                  )}
                </div>
              )}
            </Panel>
          </div>

          {/* Current state row */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-terminal-border bg-terminal-panel px-4 py-2 text-xs tabular">
            <span className="flex items-center gap-1.5">
              <span className="text-terminal-muted">Commercial</span>
              {commAvailable ? (
                <>
                  <DirectionBadge dir={comm?.direction} />
                  <span>{signed(comm?.commercial_imbalance_mwh, 1)} MWh</span>
                </>
              ) : (
                <DirectionBadge dir="UNAVAILABLE" />
              )}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-terminal-muted">GB System</span>
              <DirectionBadge dir={sys?.direction} />
              <span>{signed(sys?.net_imbalance_volume_mwh, 0)} MWh</span>
            </span>
            <span>
              <span className="text-terminal-muted">Frequency</span>{" "}
              {freq?.latest_frequency_hz != null ? `${num(freq.latest_frequency_hz, 3)} Hz` : "—"}
            </span>
            <span>
              <span className="text-terminal-muted">Price</span>{" "}
              {sys?.system_price_gbp_per_mwh != null ? `£${num(sys.system_price_gbp_per_mwh, 2)}/MWh` : "—"}
            </span>
            <span>
              <span className="text-terminal-muted">SoC</span>{" "}
              {batt?.soc_mwh != null ? `${num(batt.soc_mwh, 1)} MWh` : "—"}
            </span>
            <span>
              <span className="text-terminal-muted">Cashflow</span>{" "}
              {commAvailable && comm?.indicative_imbalance_cashflow_gbp != null
                ? gbp(comm.indicative_imbalance_cashflow_gbp, 0)
                : "—"}
            </span>
            {commAvailable && comm && <ProvBadge p={comm.provenance} />}
          </div>
        </>
      )}
    </div>
  );
}

const LADDER: [keyof CommercialPosition, string][] = [
  ["contracted_net_export_mwh", "Contracted"],
  ["scheduled_net_export_mwh", "Scheduled"],
  ["model_recommended_net_export_mwh", "Recommended"],
  ["trader_instructed_net_export_mwh", "Instructed"],
  ["executed_net_export_mwh", "Executed"],
  ["confirmed_metered_net_export_mwh", "Metered"],
];

function CommercialLadder({
  comm,
  socMwh,
}: {
  comm: CommercialPosition;
  socMwh: number | null;
}) {
  const vals = LADDER.map(([k]) => (comm[k] as number | null) ?? 0);
  const maxAbs = Math.max(...vals.map((v) => Math.abs(v)), 1);
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {LADDER.map(([k, label], i) => {
          const v = vals[i];
          const w = (Math.abs(v) / maxAbs) * 46;
          const isMetered = k === "confirmed_metered_net_export_mwh";
          const isContracted = k === "contracted_net_export_mwh";
          const color = isMetered ? "#38bdf8" : isContracted ? "#c084fc" : "#7c8896";
          return (
            <div key={k} className="flex items-center gap-2 text-[11px]">
              <span className="w-24 shrink-0 text-right text-terminal-muted">{label}</span>
              <div className="relative h-3.5 flex-1">
                <div className="absolute left-1/2 top-0 h-3.5 w-px bg-terminal-muted/40" />
                <div
                  className="absolute h-3.5 rounded-sm"
                  style={{
                    left: v >= 0 ? "50%" : `${50 - w}%`,
                    width: `${w}%`,
                    backgroundColor: color,
                    opacity: 0.85,
                  }}
                />
              </div>
              <span className="w-16 shrink-0 text-right tabular">{signed(v, 1)}</span>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-terminal-border pt-2 text-xs">
        <div>
          <div className="text-[10px] uppercase text-terminal-muted">Imbalance</div>
          <div className="tabular font-semibold">
            {signed(comm.commercial_imbalance_mwh, 2)} <span className="text-[10px] text-terminal-muted">MWh</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-terminal-muted">Ind. cashflow</div>
          <div className="tabular font-semibold">
            {comm.indicative_imbalance_cashflow_gbp != null
              ? gbp(comm.indicative_imbalance_cashflow_gbp, 0)
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase text-terminal-muted">SoC</div>
          <div className="tabular font-semibold">
            {socMwh != null ? num(socMwh, 1) : "—"} <span className="text-[10px] text-terminal-muted">MWh</span>
          </div>
        </div>
      </div>
    </div>
  );
}
