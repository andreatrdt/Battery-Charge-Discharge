"use client";

import { useEffect, useState } from "react";
import {
  api,
  gbp,
  num,
  replayApi,
  type DecisionRecord,
  type MarketSnapshot,
  type ReplayInputsPayload,
  type ReplayStatus,
  type ReplaySummary,
} from "../lib/api";
import { useAppState } from "../lib/store";
import { SourceBanner } from "../components/SourceBanner";
import { StatusBadge } from "../components/badges";
import { ErrorNote, Panel, Spinner, Tabs } from "../components/ui";

interface LastReplay {
  replay_id: string;
  day: string;
  mode: string;
  source: string;
  step_index: number;
}

type ArchivedRun = {
  replay_id: string;
  day: string;
  mode: string;
  complete: boolean;
  saved_at: string | null;
  summary: ReplaySummary | null;
};

function lastReplay(): LastReplay | null {
  try {
    const raw = localStorage.getItem("gbb_last_replay");
    return raw ? (JSON.parse(raw) as LastReplay) : null;
  } catch {
    return null;
  }
}

export default function AuditPage() {
  const [tab, setTab] = useState("Inputs");
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Audit</h1>
      <Tabs tabs={["Inputs", "Decisions", "Runs", "Sources", "Versions"]} active={tab} onChange={setTab} />
      {tab === "Inputs" && <CurrentRunInputs />}
      {tab === "Decisions" && <DecisionsTab />}
      {tab === "Runs" && <ArchivedRuns />}
      {tab === "Sources" && <SourcesTab />}
      {tab === "Versions" && <VersionsTab />}
    </div>
  );
}

/* ------------------------------------------------------------------- Inputs */

function CurrentRunInputs() {
  const [last] = useState<LastReplay | null>(lastReplay());
  const [inputs, setInputs] = useState<ReplayInputsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!last) {
      setLoading(false);
      return;
    }
    replayApi
      .inputs(last.replay_id)
      .then(setInputs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [last]);

  if (loading) return <Spinner label="Loading current run…" />;
  if (!last) return <Panel title="Current run inputs"><Empty /></Panel>;

  const base = `/api/replay/${last.replay_id}`;
  return (
    <Panel
      title="Current run inputs"
      right={
        <div className="flex gap-2 text-[11px]">
          <a className="rounded border border-terminal-border px-2 py-1 hover:bg-terminal-border/40" href={`${base}/inputs?format=csv`}>Inputs CSV</a>
          <a className="rounded border border-terminal-border px-2 py-1 hover:bg-terminal-border/40" href={`${base}/forecasts?format=csv`}>Forecasts CSV</a>
          <a className="rounded border border-terminal-border px-2 py-1 hover:bg-terminal-border/40" href={`${base}/decisions?format=csv`}>Log CSV</a>
        </div>
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
        <Meta k="Mode" v={last.mode} />
        <Meta k="Day" v={last.day} />
        <Meta k="Source" v={last.source} />
        <Meta k="Replay ID" v={last.replay_id} />
        <Meta k="As-of" v={inputs ? inputs.as_of.replace("T", " ").slice(0, 16) + "Z" : "—"} />
      </div>
      {error && <ErrorNote error={error} />}
      {inputs && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-semibold">Forecasts used (SP{inputs.settlement_period})</h3>
            <SimpleTable
              cols={["SP", "point", "q10", "q90", "basis", "provenance"]}
              rows={inputs.forecasts_used.slice(0, 50).map((f) => [f.settlement_period, f.point, f.q10, f.q90, f.basis, f.provenance])}
            />
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold">Observations visible ({inputs.n_observations_visible})</h3>
            <SimpleTable
              cols={["date", "SP", "value", "published", "provenance"]}
              rows={inputs.observations_visible.slice(-50).reverse().map((o) => [
                o.settlement_date,
                o.settlement_period,
                o.value,
                o.published_at.replace("T", " ").slice(5, 16),
                o.publication_reconstructed ? `${o.provenance} (reconstructed)` : o.provenance,
              ])}
            />
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ---------------------------------------------------------------- Decisions */

function DecisionsTab() {
  const [last] = useState<LastReplay | null>(lastReplay());
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!last) {
      setLoading(false);
      return;
    }
    replayApi
      .decisions(last.replay_id)
      .then((r) => setDecisions(r.decisions))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [last]);

  if (loading) return <Spinner label="Loading decisions…" />;
  if (!last) return <Panel title="Trader decision history"><Empty /></Panel>;

  return (
    <Panel title={`Trader decision history (${decisions.length})`}>
      {error && <ErrorNote error={error} />}
      <div className="scroll-x max-h-[60vh] overflow-y-auto rounded border border-terminal-border/60">
        <table className="w-full text-[11px] tabular">
          <thead className="sticky top-0 bg-terminal-panel">
            <tr className="text-left text-terminal-muted">
              {["SP", "Contracted", "Recommended", "Instructed", "Executed", "Metered", "Comm. imb.", "SoC", "Realised £", "State"].map((h) => (
                <th key={h} className="whitespace-nowrap border-b border-terminal-border px-2 py-1.5">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {decisions.map((d) => {
              const c = d.commercial;
              return (
                <tr key={d.step} className="border-b border-terminal-border/30">
                  <td className="px-2 py-1">{d.settlement_date.slice(5)}·{d.settlement_period}</td>
                  <td className="px-2 py-1">{c?.contracted_net_export_mwh != null ? num(c.contracted_net_export_mwh, 1) : "—"}</td>
                  <td className="px-2 py-1">{c?.model_recommended_net_export_mwh != null ? num(c.model_recommended_net_export_mwh, 1) : "—"}</td>
                  <td className="px-2 py-1">{c?.trader_instructed_net_export_mwh != null ? num(c.trader_instructed_net_export_mwh, 1) : "—"}</td>
                  <td className="px-2 py-1">{c?.executed_net_export_mwh != null ? num(c.executed_net_export_mwh, 1) : "—"}</td>
                  <td className="px-2 py-1">{c?.confirmed_metered_net_export_mwh != null ? num(c.confirmed_metered_net_export_mwh, 1) : "—"}</td>
                  <td className="px-2 py-1">{c?.commercial_imbalance_mwh != null ? num(c.commercial_imbalance_mwh, 2) : "—"}</td>
                  <td className="px-2 py-1">{num(d.soc_after_mwh, 1)}</td>
                  <td className="px-2 py-1">{d.realised_pnl_gbp != null ? gbp(d.realised_pnl_gbp, 0) : "—"}</td>
                  <td className="px-2 py-1"><StatusBadge status={d.settlement_status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------- Runs */

function ArchivedRuns() {
  const [runs, setRuns] = useState<ArchivedRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    replayApi
      .archivedRuns()
      .then((r) => setRuns(r.runs))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Panel title="Persistent replay archive (DuckDB)">
      {loading && <Spinner label="Loading…" />}
      {error && <ErrorNote error={error} />}
      {!loading && !error && runs.length === 0 && <Empty />}
      {runs.length > 0 && (
        <div className="scroll-x rounded border border-terminal-border/60">
          <table className="w-full text-[11px] tabular">
            <thead className="bg-terminal-panel">
              <tr className="text-left text-terminal-muted">
                {["Replay ID", "Day", "Mode", "Complete", "Saved", "Realised P&L", "Cycles", "End SoC"].map((h) => (
                  <th key={h} className="whitespace-nowrap border-b border-terminal-border px-2 py-1.5">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.replay_id} className="border-b border-terminal-border/30">
                  <td className="max-w-52 truncate px-2 py-1" title={r.replay_id}>{r.replay_id}</td>
                  <td className="px-2 py-1">{r.day}</td>
                  <td className="px-2 py-1">{r.mode}</td>
                  <td className="px-2 py-1">{r.complete ? "yes" : "no"}</td>
                  <td className="px-2 py-1">{r.saved_at ? r.saved_at.replace("T", " ").slice(0, 16) : "—"}</td>
                  <td className="px-2 py-1">{r.summary ? gbp(r.summary.realised_pnl_gbp, 0) : "—"}</td>
                  <td className="px-2 py-1">{r.summary ? num(r.summary.cycles, 2) : "—"}</td>
                  <td className="px-2 py-1">{r.summary ? `${num(r.summary.ending_soc_mwh, 1)} MWh` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ----------------------------------------------------------------- Sources */

function SourcesTab() {
  const { day, source, networkPolicy } = useAppState();
  const [snap, setSnap] = useState<MarketSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sample, setSample] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .snapshot(day, source, networkPolicy)
      .then(setSnap)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    api.sample(96).then((d) => setSample({ columns: d.columns, rows: d.rows })).catch(() => {});
  }, [day, source, networkPolicy]);

  const cols = snap?.periods[0] ? Object.keys(snap.periods[0]) : [];
  return (
    <div className="space-y-3">
      <Panel title={`Selected source — ${source}`}>
        <SourceBanner provenance={snap?.provenance} warnings={snap?.warnings} />
        {error && <div className="mt-2"><ErrorNote error={error} /></div>}
        {loading && <Spinner label="Loading…" />}
        {snap && !loading && (
          <div className="mt-2 scroll-x max-h-72 overflow-y-auto rounded border border-terminal-border/60">
            <table className="w-full text-[11px] tabular">
              <thead className="sticky top-0 bg-terminal-panel">
                <tr className="text-left text-terminal-muted">
                  {cols.map((c) => (
                    <th key={c} className="whitespace-nowrap border-b border-terminal-border px-2 py-1">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snap.periods.slice(0, 50).map((r, i) => (
                  <tr key={i} className="border-b border-terminal-border/30">
                    {cols.map((c) => (
                      <td key={c} className="whitespace-nowrap px-2 py-0.5">{r[c] == null ? "—" : String(r[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Bundled synthetic dataset (raw)">
        {sample ? (
          <div className="scroll-x max-h-72 overflow-y-auto rounded border border-terminal-border/60">
            <table className="text-[11px] tabular">
              <thead className="sticky top-0 bg-terminal-panel">
                <tr className="text-left text-terminal-muted">
                  {sample.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap border-b border-terminal-border px-2 py-1">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sample.rows.slice(0, 48).map((r, i) => (
                  <tr key={i} className="border-b border-terminal-border/30">
                    {sample.columns.map((c) => (
                      <td key={c} className="whitespace-nowrap px-2 py-0.5">{r[c] == null ? "—" : String(r[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Spinner label="Loading…" />
        )}
      </Panel>
    </div>
  );
}

/* ---------------------------------------------------------------- Versions */

function VersionsTab() {
  const [last] = useState<LastReplay | null>(lastReplay());
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!last) {
      setLoading(false);
      return;
    }
    replayApi.status(last.replay_id).then(setStatus).catch(() => {}).finally(() => setLoading(false));
  }, [last]);

  if (loading) return <Spinner label="Loading…" />;
  if (!last || !status) return <Panel title="Version stamps"><Empty /></Panel>;
  const versions = (status.versions || {}) as Record<string, string>;
  return (
    <Panel title="Version stamps">
      <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
        {Object.entries(versions).map(([k, v]) => (
          <Meta key={k} k={k} v={String(v)} />
        ))}
      </div>
    </Panel>
  );
}

/* ----------------------------------------------------------------- shared */

function Empty() {
  return <p className="text-xs text-terminal-muted">No active session. Start one on Trading.</p>;
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded border border-terminal-border/60 px-2 py-1">
      <div className="text-[10px] uppercase text-terminal-muted">{k}</div>
      <div className="tabular truncate" title={v}>{v}</div>
    </div>
  );
}

function SimpleTable({ cols, rows }: { cols: string[]; rows: (string | number)[][] }) {
  return (
    <div className="scroll-x max-h-80 overflow-y-auto rounded border border-terminal-border/60">
      <table className="w-full text-[11px] tabular">
        <thead className="sticky top-0 bg-terminal-panel">
          <tr className="text-left text-terminal-muted">
            {cols.map((c) => (
              <th key={c} className="whitespace-nowrap border-b border-terminal-border px-2 py-1">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-terminal-border/30">
              {r.map((c, j) => (
                <td key={j} className="whitespace-nowrap px-2 py-0.5">{String(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
