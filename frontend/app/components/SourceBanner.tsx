"use client";

/** Provenance banner: what source/day was requested vs actually served. */

import type { SourceProvenance } from "../lib/api";
import { ProvBadge } from "./learn";

export function SourceBanner({
  provenance,
  warnings,
}: {
  provenance: SourceProvenance | null | undefined;
  warnings?: string[];
}) {
  if (!provenance) return null;
  const p = provenance;
  const fellBack = p.requested_source !== p.actual_source;
  const provKind =
    p.actual_source === "elexon" ? "observed" : p.actual_source === "sample" ? "frozen sample" : "synthetic";
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-[11px] ${
        fellBack || p.date_substituted
          ? "border-kind-estimated/50 bg-kind-estimated/10"
          : "border-terminal-border bg-terminal-panel"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-1">
          <span className="text-terminal-muted">Source:</span>
          <ProvBadge p={provKind} />
          {fellBack && (
            <span className="text-kind-estimated">
              (requested {p.requested_source}, actual {p.actual_source})
            </span>
          )}
        </span>
        <span>
          <span className="text-terminal-muted">Data day:</span> {p.actual_data_day}
          {p.date_substituted && (
            <span className="text-kind-estimated"> (requested {p.requested_day}, substituted)</span>
          )}
        </span>
        <span>
          <span className="text-terminal-muted">Network:</span>{" "}
          {p.network_used ? "used" : "not used"}
        </span>
        <span>
          <span className="text-terminal-muted">Cache:</span> {p.cache_used ? "used" : "not used"}
        </span>
      </div>
      {warnings && warnings.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-kind-estimated">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
