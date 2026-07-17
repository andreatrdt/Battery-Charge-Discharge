"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { ErrorNote, Panel, Spinner } from "../components/ui";

export default function DataExplorer() {
  const [data, setData] = useState<{ columns: string[]; rows: Record<string, unknown>[]; total_rows: number; note: string } | null>(null);
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
    a.download = "gb_battery_sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Data Explorer</h1>
          <p className="text-xs text-terminal-muted">Frozen synthetic sample with source &amp; timestamp lineage.</p>
        </div>
        {data && (
          <button onClick={downloadCsv} className="rounded border border-terminal-border px-3 py-1.5 text-xs hover:bg-terminal-border/40">
            Download CSV
          </button>
        )}
      </div>

      {error && <ErrorNote error={error} />}
      {loading && <Spinner label="Loading sample…" />}

      {data && !loading && (
        <Panel title={`Preview (${data.rows.length} of ${data.total_rows} rows)`}>
          <p className="mb-2 text-xs text-kind-synthetic">{data.note}</p>
          <div className="scroll-x max-h-[70vh]">
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
                        {String(r[c] ?? "—")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
