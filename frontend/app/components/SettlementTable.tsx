"use client";

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import type { PeriodResult } from "../lib/api";
import { num } from "../lib/api";
import { ActionBadge } from "./ui";

function hhmm(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
}

export function SettlementTable({
  periods,
  onSelect,
  selected,
}: {
  periods: PeriodResult[];
  onSelect: (sp: number) => void;
  selected: number | null;
}) {
  const columns = useMemo<ColumnDef<PeriodResult>[]>(
    () => [
      { header: "SP", accessorKey: "settlement_period", cell: (c) => <span className="text-terminal-muted">{c.getValue<number>()}</span> },
      { header: "Time", accessorFn: (r) => hhmm(r.start_utc), id: "time" },
      { header: "Action", accessorKey: "action", cell: (c) => <ActionBadge action={c.row.original.action} /> },
      { header: "Whsl £/MWh", accessorKey: "wholesale_price", cell: (c) => priceCell(c.getValue<number>()) },
      { header: "±σ", accessorKey: "wholesale_price_sigma", cell: (c) => <span className="text-terminal-muted">{num(c.getValue<number>())}</span> },
      { header: "Sys £/MWh", accessorKey: "system_price", cell: (c) => num(c.getValue<number>() ?? null) },
      { header: "P(short)", accessorKey: "prob_short", cell: (c) => pctCell(c.getValue<number>() ?? null) },
      { header: "Demand", accessorKey: "demand_forecast_mw", cell: (c) => num(c.getValue<number>() ?? null, 0) },
      { header: "Wind", accessorKey: "wind_forecast_mw", cell: (c) => num(c.getValue<number>() ?? null, 0) },
      { header: "Solar", accessorKey: "solar_forecast_mw", cell: (c) => num(c.getValue<number>() ?? null, 0) },
      { header: "Chg MW", accessorKey: "charge_mw", cell: (c) => mwCell(c.getValue<number>(), "#22c55e") },
      { header: "Dis MW", accessorKey: "discharge_mw", cell: (c) => mwCell(c.getValue<number>(), "#ef4444") },
      { header: "SoC→", accessorKey: "ending_soc_mwh", cell: (c) => <span className="tabular">{num(c.getValue<number>())}</span> },
      { header: "Up MW", accessorKey: "upward_reserved_mw", cell: (c) => mwCell(c.getValue<number>(), "#eab308") },
      { header: "Dn MW", accessorKey: "downward_reserved_mw", cell: (c) => mwCell(c.getValue<number>(), "#0ea5e9") },
      { header: "Whsl P&L", accessorKey: "wholesale_pnl_gbp", cell: (c) => pnlCell(c.getValue<number>()) },
      { header: "Svc P&L", accessorKey: "service_pnl_gbp", cell: (c) => pnlCell(c.getValue<number>()) },
      { header: "Degr", accessorKey: "degradation_cost_gbp", cell: (c) => <span className="text-action-discharge">−{num(c.getValue<number>(), 0)}</span> },
      { header: "Total P&L", accessorKey: "total_expected_pnl_gbp", cell: (c) => pnlCell(c.getValue<number>(), true) },
      {
        header: "Binding",
        accessorKey: "binding_constraints",
        cell: (c) => (
          <span className="text-[10px] text-terminal-muted">{c.getValue<string[]>().join(", ") || "—"}</span>
        ),
      },
    ],
    [],
  );

  const table = useReactTable({ data: periods, columns, getCoreRowModel: getCoreRowModel() });

  return (
    <div className="scroll-x rounded-lg border border-terminal-border">
      <table className="w-full text-xs tabular border-collapse">
        <thead className="bg-terminal-panel sticky top-0">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id} className="whitespace-nowrap px-2 py-2 text-left font-semibold text-terminal-muted border-b border-terminal-border">
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const sp = row.original.settlement_period;
            const isSel = sp === selected;
            return (
              <tr
                key={row.id}
                onClick={() => onSelect(sp)}
                className={`cursor-pointer border-b border-terminal-border/50 hover:bg-terminal-border/30 ${
                  isSel ? "bg-kind-observed/10" : ""
                }`}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="whitespace-nowrap px-2 py-1.5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function priceCell(v: number) {
  return <span className={v < 0 ? "text-action-charge" : "text-terminal-text"}>{num(v)}</span>;
}
function mwCell(v: number, color: string) {
  return v > 0.001 ? <span style={{ color }}>{num(v)}</span> : <span className="text-terminal-muted">—</span>;
}
function pnlCell(v: number, bold = false) {
  const color = v > 0 ? "#22c55e" : v < 0 ? "#ef4444" : "#7c8896";
  return (
    <span style={{ color }} className={bold ? "font-semibold" : ""}>
      {v >= 0 ? "+" : "−"}
      {num(Math.abs(v), 0)}
    </span>
  );
}
function pctCell(v: number | null) {
  if (v === null) return <span className="text-terminal-muted">—</span>;
  return <span>{(v * 100).toFixed(0)}%</span>;
}
