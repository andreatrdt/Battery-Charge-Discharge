"use client";

import { useEffect, useState } from "react";
import { api, replayApi, type ReplayInputsPayload } from "../lib/api";
import { ErrorNote, Panel, Spinner } from "../components/ui";

interface LastReplay {
  replay_id: string;
  day: string;
  mode: string;
  source: string;
  step_index: number;
}

export default function DataExplorer() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Data</h1>
        <p className="text-xs text-terminal-muted">
          Two strictly separated sections: the inputs actually used by your current replay/live run,
          and the bundled synthetic demonstration dataset.
        </p>
      </div>
      <CurrentRunInputs />
      <BundledSample />
    </div>
  );
}

/* ----------------------------------------------------- current run inputs */

function CurrentRunInputs() {
  const [last, setLast] = useState<LastReplay | null>(null);
  const [inputs, setInputs] = useState<ReplayInputsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let info: LastReplay | null = null;
    try {
      const raw = localStorage.getItem("gbb_last_replay");
      if (raw) info = JSON.parse(raw) as LastReplay;
    } catch {
      /* ignore */
    }
    setLast(info);
    if (!info) {
      setLoading(false);
      return;
    }
    replayApi
      .inputs(info.replay_id)
      .then(setInputs)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner label="Looking for the current run…" />;

  if (!last) {
    return (
      <Panel title="Current run inputs">
        <p className="text-xs text-terminal-muted">
          No replay or live session found in this browser. Start one on the{" "}
          <a href="/replay" className="text-kind-observed underline">
            Replay &amp; Live
          </a>{" "}
          page — the exact rows behind each decision will appear here with full provenance.
        </p>
      </Panel>
    );
  }

  const base = `/api/replay/${last.replay_id}`;
  return (
    <Panel
      title="Current run inputs"
      right={
        <div className="flex gap-2 text-[11px]">
          <a className="rounded border border-terminal-border px-2 py-1 hover:bg-terminal-border/40" href={`${base}/inputs?format=csv`}>
            Download decision inputs
          </a>
          <a className="rounded border border-terminal-border px-2 py-1 hover:bg-terminal-border/40" href={`${base}/forecasts?format=csv`}>
            Download forecasts
          </a>
          <a className="rounded border border-terminal-border px-2 py-1 hover:bg-terminal-border/40" href={`${base}/decisions?format=csv`}>
            Download replay log
          </a>
        </div>
      }
    >
      <div className="mb-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
        <Meta k="Mode" v={last.mode} />
        <Meta k="Day" v={last.day} />
        <Meta k="Source" v={last.source} />
        <Meta k="Replay ID" v={last.replay_id} />
        <Meta k="As-of (latest decision)" v={inputs ? inputs.as_of.replace("T", " ").slice(0, 16) + "Z" : "—"} />
      </div>

      {error && (
        <ErrorNote error={`${error} — the session may have expired (sessions are in-memory); start a new replay.`} />
      )}

      {inputs && (
        <>
          <p className="mb-2 text-[11px] text-terminal-muted">
            Rows visible to the decision for SP{inputs.settlement_period} (published at or before the
            as-of instant). {inputs.n_observations_visible} observations +{" "}
            {inputs.forecasts_used.length} forecast rows.
            {inputs.store_notes.map((n, i) => (
              <span key={i} className="block text-kind-estimated">
                {n}
              </span>
            ))}
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-1 text-xs font-semibold">
                Forecasts used (model, issued at the gate)
              </h3>
              <SimpleTable
                cols={["SP", "point", "q10", "q90", "basis", "provenance"]}
                rows={inputs.forecasts_used.slice(0, 50).map((f) => [
                  f.settlement_period,
                  f.point,
                  f.q10,
                  f.q90,
                  f.basis,
                  f.provenance,
                ])}
              />
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold">
                Most recent observations visible (of {inputs.n_observations_visible})
              </h3>
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
        </>
      )}
    </Panel>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded border border-terminal-border/60 px-2 py-1">
      <div className="text-[10px] uppercase text-terminal-muted">{k}</div>
      <div className="tabular truncate">{v}</div>
    </div>
  );
}

function SimpleTable({ cols, rows }: { cols: string[]; rows: (string | number)[][] }) {
  return (
    <div className="scroll-x max-h-80 overflow-y-auto rounded border border-terminal-border/60">
      <table className="w-full text-[11px] tabular">
        <thead className="sticky top-0 bg-terminal-panel">
          <tr className="text-terminal-muted text-left">
            {cols.map((c) => (
              <th key={c} className="whitespace-nowrap px-2 py-1 border-b border-terminal-border">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-terminal-border/30">
              {r.map((c, j) => (
                <td key={j} className="whitespace-nowrap px-2 py-0.5">
                  {String(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------- bundled sample */

function BundledSample() {
  const [data, setData] = useState<{
    columns: string[];
    rows: Record<string, unknown>[];
    total_rows: number;
    note: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .sample(96)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const downloadCsv = () => {
    if (!data) return;
    const header = data.columns.join(",");
    const lines = data.rows.map((r) => data.columns.map((c) => r[c] ?? "").join(","));
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gb_battery_synthetic_sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Panel
      title="Bundled synthetic demonstration dataset"
      right={
        data && (
          <button
            onClick={downloadCsv}
            className="rounded border border-terminal-border px-2 py-1 text-[11px] hover:bg-terminal-border/40"
          >
            Download CSV
          </button>
        )
      }
    >
      <p className="mb-2 text-xs text-kind-synthetic">
        Generated demo data (35 seeded days, provenance <strong>synthetic</strong>) so the app runs
        fully offline. It is <strong>not</strong> observed market data and is <strong>not</strong>{" "}
        necessarily what your current run used — see &ldquo;Current run inputs&rdquo; above for
        that.
      </p>
      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Loading sample…" />}
      {data && !loading && (
        <div className="scroll-x max-h-[50vh] overflow-y-auto">
          <table className="text-[11px] tabular">
            <thead className="sticky top-0 bg-terminal-panel">
              <tr className="text-terminal-muted text-left">
                {data.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2 py-1.5 border-b border-terminal-border">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r, i) => (
                <tr key={i} className="border-b border-terminal-border/40">
                  {data.columns.map((c) => (
                    <td key={c} className="whitespace-nowrap px-2 py-1">
                      {r[c] === null || r[c] === undefined ? "—" : String(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
