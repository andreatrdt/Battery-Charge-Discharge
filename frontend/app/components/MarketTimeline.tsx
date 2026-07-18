"use client";

/** The GB market process timeline — reused across pages (Phase 3). */

import { useState } from "react";
import { useAppState } from "../lib/store";

interface Stage {
  key: string;
  label: string;
  what: string;
  who: string;
  traded: string;
  physical: string;
  price: string;
  known: string;
  uncertain: string;
}

const STAGES: Stage[] = [
  {
    key: "forecast",
    label: "Forecast creation",
    what: "Forecasters publish demand, wind, solar and price views for tomorrow.",
    who: "NESO, Elexon, commercial forecasters, this app's model",
    traded: "Nothing — information only.",
    physical: "No — the battery is not moving.",
    price: "None yet.",
    known: "History, weather models, calendar effects.",
    uncertain: "Everything about tomorrow's actual outturn.",
  },
  {
    key: "day_ahead",
    label: "Day-ahead market",
    what: "Hourly/half-hourly energy for tomorrow is auctioned (e.g. EPEX/N2EX).",
    who: "Generators, suppliers, traders, storage.",
    traded: "Energy (MWh) for each period of tomorrow.",
    physical: "No — commitments only; delivery is tomorrow.",
    price: "Day-ahead auction price. This app uses MID as a reference, not the auction book.",
    known: "Day-ahead forecasts, positions.",
    uncertain: "Intraday swings, plant outages, forecast errors.",
  },
  {
    key: "intraday",
    label: "Intraday trading",
    what: "Positions are adjusted continuously as forecasts update.",
    who: "The same participants, closer to real time.",
    traded: "Energy (MWh), continuously.",
    physical: "Not yet — still trading ahead of delivery.",
    price: "Continuous intraday prices; MID summarises them per period.",
    known: "Latest forecasts, own outages, updated weather.",
    uncertain: "The final imbalance of the system.",
  },
  {
    key: "gate",
    label: "Gate closure",
    what: "1 h before delivery each participant's position is fixed and notified.",
    who: "All balancing-responsible parties.",
    traded: "Nothing new — final physical notifications are submitted.",
    physical: "Commitment fixed; delivery imminent.",
    price: "No new price; the die is cast.",
    known: "Your own final position.",
    uncertain: "Real-time system stress, actual delivery.",
  },
  {
    key: "bm",
    label: "Balancing Mechanism",
    what: "NESO accepts Bids/Offers in real time to balance the system.",
    who: "NESO and BM units (this app treats BM as experimental only).",
    traded: "Deviations (MW for a duration) at submitted Bid/Offer prices.",
    physical: "Yes — accepted actions physically move plant.",
    price: "Accepted Bid/Offer prices.",
    known: "Instructions received.",
    uncertain: "Whether your Bid/Offer is accepted at all.",
  },
  {
    key: "delivery",
    label: "Physical delivery",
    what: "The half-hour actually happens; the battery physically charges/discharges.",
    who: "Everyone, physically.",
    traded: "Nothing — this is delivery, not trading.",
    physical: "YES — this is the only stage where energy actually flows.",
    price: "N/A (prices were set before/after).",
    known: "What you are doing right now.",
    uncertain: "The final metered imbalance settlement.",
  },
  {
    key: "imbalance",
    label: "Imbalance settlement",
    what: "Differences between contracted and delivered energy are cashed out.",
    who: "Elexon settles every balancing-responsible party.",
    traded: "Nothing — accounting of what already happened.",
    physical: "No — pure settlement.",
    price: "The system (imbalance settlement) price.",
    known: "Eventually everything — after publication lags and revisions.",
    uncertain: "Only revisions.",
  },
];

export function MarketTimeline({ highlight }: { highlight?: string }) {
  const { learning } = useAppState();
  const [open, setOpen] = useState<string | null>(null);
  const stage = STAGES.find((s) => s.key === open) || null;
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2">
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        {STAGES.map((s, i) => (
          <span key={s.key} className="flex items-center gap-1">
            {i > 0 && <span className="text-terminal-muted">→</span>}
            <button
              onClick={() => setOpen(open === s.key ? null : s.key)}
              className={`rounded px-2 py-0.5 border transition-colors ${
                highlight === s.key
                  ? "border-kind-observed text-kind-observed bg-kind-observed/15 font-semibold"
                  : open === s.key
                    ? "border-kind-forecast text-kind-forecast"
                    : "border-transparent text-terminal-muted hover:text-terminal-text"
              }`}
            >
              {s.label}
            </button>
          </span>
        ))}
      </div>
      {stage && (
        <div className="mt-2 grid gap-x-6 gap-y-1 border-t border-terminal-border pt-2 text-[11px] md:grid-cols-2">
          <div><span className="text-terminal-muted">What happens: </span>{stage.what}</div>
          <div><span className="text-terminal-muted">Who: </span>{stage.who}</div>
          <div><span className="text-terminal-muted">What is traded: </span>{stage.traded}</div>
          <div><span className="text-terminal-muted">Battery physically moving? </span>{stage.physical}</div>
          <div><span className="text-terminal-muted">Price that applies: </span>{stage.price}</div>
          <div><span className="text-terminal-muted">Known: </span>{stage.known}</div>
          <div className="md:col-span-2">
            <span className="text-terminal-muted">Still uncertain: </span>{stage.uncertain}
          </div>
        </div>
      )}
      {learning && !stage && (
        <p className="mt-1 text-[10px] text-terminal-muted">
          Click a stage to see what happens there. The highlighted stage is the one the current
          page&apos;s numbers belong to.
        </p>
      )}
    </div>
  );
}
