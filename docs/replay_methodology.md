# Replay & Live Trading methodology

The Replay subsystem answers the question a credible trading-research platform must be
able to prove, not just assert:

> At every historical or live decision timestamp, what information was available, what
> did the model forecast, what action did it choose, and how did that decision perform
> once the actual outcome became known?

## Three strictly separated modes

| Mode | Decides on | Settles on | Purpose |
|------|-----------|------------|---------|
| **Historical Replay** | Point-in-time information only | Published outturns | The credible strategy result |
| **Live Paper Trading** | Point-in-time information up to *now* | Outturns as they publish | Same loop, applied to today |
| **Perfect Foresight** | The realised price path | The realised price path | Labelled upper bound only |

Perfect foresight is computed and displayed **only** as a benchmark and is never mixed
into replay or paper-trading P&L.

## The cross-day rolling decision loop

For each executed Settlement Period *t*, in chronological order:

1. **Gate**: `as_of` is the period start.
2. **Information set**: `PITDataStore` returns only records with
   `published_at <= as_of`; a violation raises `PITViolation`.
3. **Forecast**: `PITForecaster` issues a point + q10/q50/q90 vintage for the full
   configured optimisation horizon.
4. **Cross-day horizon**: 24, 48 or 72 hours (48 by default), built with the DST-aware
   settlement calendar and allowed to cross midnight.
5. **Continuation estimate**: an explicit £/MWh value is assigned to stored energy at
   horizon end using forecast prices beyond the active horizon.
6. **Optimise**: Pyomo/HiGHS solves the wholesale-only battery problem with current SoC,
   physical limits and remaining cycle budget.
7. **Execute one period**: only the first proposed action enters the execution model.
8. **Execution**: requested and executed MW are stored separately; simulated spread,
   slippage, fees and volume limits may reduce the fill. Executed volume drives SoC.
9. **Settle**: once the outturn is published, gross reference-price P&L, execution costs,
   degradation and net realised paper P&L are recorded.
10. **Carry state**: SoC, daily/cumulative cycles, P&L and decision history continue
    across midnight. Nothing resets merely because the calendar date changes.

The full proposed schedule from every vintage is retained, although only its first
period is executed. This makes replanning auditable.

## Energy action versus flexibility

The API and UI expose two independent concepts:

- **energy action**: `CHARGE`, `DISCHARGE` or `IDLE`; this changes SoC;
- **flexibility position**: `UP`, `DOWN`, `BOTH` or `NONE`; this is a physical capability
  estimate around the operating point.

An idle battery can therefore be `IDLE + BOTH`. Flexibility is not evidence of a
reserve offer, award, availability payment or activation.

## Point-in-time data rules

Every record carries `published_at` in addition to event time. Provenance is one of:

`observed` · `published_forecast` · `model_forecast` · `reconstructed` ·
`synthetic` · `assumed` · `perfect_foresight`

Availability assumptions:

- **Elexon MID** has no per-record publication timestamp, so replay availability is
  reconstructed as period end + a configurable lag (10 minutes by default) and flagged
  `publication_reconstructed`.
- **Demand / wind / solar forecasts** use real publication timestamps when available.
- **Synthetic data** follows the same availability discipline as live data.
- The actual outturn is never silently substituted for an unavailable forecast.

## Point-in-time forecaster

The transparent baseline uses:

- published price forecast when available;
- same-SP visible lags / rolling same-SP median;
- intraday EWMA bias correction from prices published so far;
- horizon-dependent q10/q50/q90 uncertainty.

Every vintage records issue time, information cutoff, newest publication used, input
counts, basis, provenance and full target-period rows.

## Forecast validation

The validation module compares:

- persistence;
- same SP yesterday;
- same SP last week;
- seven-day same-SP rolling median;
- weekday/SP climatology;
- the internal PIT model.

Two framings are kept separate:

1. **one-step-ahead** metrics for the forecast actually used at each rolling gate;
2. **start-of-day path** metrics for peak/trough timing and ramp behaviour.

Reported metrics include MAE, RMSE, bias, correlation, directional accuracy, ramp MAE,
peak/trough timing error, pinball losses, q10–q90 coverage, interval width and calibration.
MAPE is deliberately not a headline metric because prices and solar may be zero or negative.

Each price model may also drive the identical rolling replay, so statistical accuracy is
shown beside realised strategy P&L.

## Trader metrics and attribution

Completed runs report performance, risk, battery and execution metrics, including:

- realised gross/net P&L, hit rate, average win/loss, payoff ratio and profit factor;
- maximum drawdown, P&L volatility, historical VaR and Expected Shortfall;
- charge/discharge throughput, equivalent cycles and time near physical limits;
- requested/executed/unfilled volume, spread/slippage/fee costs;
- regret and capture versus perfect foresight;
- regime-level forecast error and P&L.

The P&L attribution reconciles expected model P&L to realised net P&L using defensible
price-forecast, volume, execution-cost and residual/interaction effects. The residual is
shown explicitly rather than inventing false precision.

## Decision alternatives and marginals

For an audited gate the alternatives endpoint performs genuine re-solves for selected,
forced-charge, forced-discharge and forced-idle cases. It reports immediate value, future
value, continuation value, total objective, next-best action and value gap.

Marginal values are exposed only where the perturbation is mathematically meaningful,
with units such as £/MWh, £/MW or £/cycle.

## Execution modes

- **Ideal**: full simulated fill at MID (theoretical reference benchmark).
- **Simple realistic**: simulated spread, fees, slippage and volume cap.
- **Stress**: wider costs and lower available volume.

These are assumptions, not reconstructed order-book executions. MID remains a reference
price, not a bid/ask quote.

## Persistence, audit trail and recovery

Two DuckDB stores back every run:

**`replay_runs`** — a snapshot document per run: options, battery configuration,
strategy/forecast/optimiser/execution version stamps, decisions, forecast vintages,
summaries and cached metrics. Written when the session is created and refreshed as it
progresses.

**`replay_transitions`** — the **append-only audit trail**. Every state transition is
appended with a monotonic sequence number and is never updated or deleted:

| Transition | Recorded inputs |
|---|---|
| `RECOMMENDATION` | decision gate time, the advisory recommendation |
| `TRADER_INSTRUCTION` | decision, MW, reason, actor, source, timestamp |
| `EXECUTION` | execution source and the resulting fill |
| `PHYSICAL_STATE_CONFIRMATION` | executed overrides, confirmed SoC, SoC source, and the size of the schedule being superseded |
| `ADVANCE` | the resulting state (supersession point) |

Because each stage is deterministic given its recorded inputs and the point-in-time
store, an **active mid-flight session is recoverable after a process restart** by
replaying the log: the exact state-machine position, SoC, cycle budgets, committed
decisions and superseded schedules are restored, and the gate can then be completed
normally. Recovery only reads the log; it never rewrites history, and the engine's
audit hook is disabled while replaying so no duplicate rows are appended.

If the database cannot be opened (DuckDB allows a single writer process), the archive
degrades to a disabled no-op: replays continue in memory, `persistence_available` is
`false` and a warning states the run will not survive a restart — never a 500.

Re-solves such as decision alternatives require a live (or recovered) session.

## Leakage audit

`GET /api/replay/{id}/metrics` proves per decision that:

- `basis_max_published_at <= as_of`; and
- the settled outturn became available only after the gate.

Tests cover future-record rejection, first-action-only execution, SoC carry, cross-midnight
horizons, 46/48/50-SP days, execution fills, continuation value, metric reconciliation and
live-mode null future actuals.

## Scope boundaries

The credible replay headline is wholesale-only and simulated. It does **not** claim:

- exchange order-book access or live execution;
- real reserve procurement, awards or activation;
- guaranteed BM acceptance;
- production asset control.

Reserve and BM values are isolated in the **Reserve & BM Laboratory**, labelled
experimental/assumed and excluded from credible realised replay P&L.
