# GB market methodology

## Settlement Periods

The GB market settles in half-hourly **Settlement Periods (SPs)**. A **Settlement Date** runs
from local (Europe/London) midnight to the next. Because of British Summer Time:

- **46 SPs** on the spring-forward day (clocks 01:00→02:00; one hour skipped)
- **48 SPs** on a normal day
- **50 SPs** on the autumn-back day (clocks 02:00→01:00; one hour repeated)

Each SP is always **30 real minutes**, so per-period duration Δt = 0.5 h, but the number of
periods per day varies. Code derives duration from timestamps and never assumes 48 SPs
(`gb_battery.settlement`).

## Wholesale vs Balancing Mechanism vs imbalance

- **Wholesale** — day-ahead and intraday energy trading. This project uses Elexon **Market
  Index Data (MID)** as a short-term reference price. MID is *not* a full EPEX order book and
  does not represent achievable execution or depth.
- **Balancing Mechanism (BM)** — after gate closure NESO balances the system by accepting
  **Bids** (reduce output / increase demand) and **Offers** (increase output / reduce demand)
  submitted as **Bid-Offer Data (BOD)**. Acceptances appear as **BOALF** (acceptance levels)
  and **BOAV** (volumes). Submitting a bid/offer price alone earns nothing — revenue depends on
  being **accepted**.
- **Imbalance settlement** — any residual difference between contracted and metered position is
  settled at the **system price** (single-price regime). Being short pays the system price;
  being long receives it. `netImbalanceVolume` and the system price indicate whether the system
  is long or short.

## System long/short

We derive a `prob_short` indicator from residual demand (demand − wind − solar) and, where
available, the net imbalance volume. A tight (short) system tends to raise imbalance prices and
the value of upward flexibility; a long system raises the value of downward flexibility.

## Ancillary services

NESO procures frequency response and reserve products — **Dynamic Containment (DC)**,
**Dynamic Moderation (DM)**, **Dynamic Regulation (DR)**, **Balancing Reserve**, and Quick/Slow
Reserve — plus capacity via the **Enduring Auction Capability (EAC)**. Batteries earn an
**availability** payment for holding capability and may earn an **activation** margin when
called. Real product rules (symmetry, baselining, duration, response speed, delivery
verification, non-delivery penalties) are more detailed than the conservative headroom
constraints modelled here.

## Fundamentals used

National demand (forecast & outturn), wind & solar (forecast & outturn), residual demand,
generation mix by fuel, and interconnector flows. These drive both the display and the
forecasting features.

## GB balance model: three separate concepts

The application distinguishes three quantities that are never merged and never inferred from
one another. Backend models live in `gb_battery/market/balance.py`; the combined snapshot is
served by `GET /api/market/balance`.

### 1. Commercial Imbalance (this portfolio)

A strict **net-export** sign convention is used everywhere:

- contracted/delivered **export** (sale): positive MWh;
- contracted/delivered **import** (purchase/charging): negative MWh.

```text
commercial_imbalance_mwh = confirmed_metered_net_export_mwh − contracted_net_export_mwh

  > +tolerance  → LONG
  < −tolerance  → SHORT
  otherwise     → BALANCED   (tolerance = 0.05 MWh, documented in balance.py)
```

Worked examples (all reflected in `tests/test_commercial_imbalance.py`):

| Contracted | Delivered | Imbalance | Direction |
|---|---|---|---|
| Sold 20 MWh (+20) | 18 MWh (+18) | −2 | SHORT 2 |
| Sold 20 MWh (+20) | 23 MWh (+23) | +3 | LONG 3 |
| Bought 20 MWh (−20) | consumed 18 (−18) | +2 | LONG 2 |
| Bought 20 MWh (−20) | consumed 23 (−23) | −3 | SHORT 3 |

Stages are kept strictly separate: **Contracted → Recommended → Instructed → Executed → Metered**.

- **Contracted** is an immutable per-session schedule, frozen at session start from a day-ahead
  optimisation (`provenance = paper_day_ahead_plan`) or a user-supplied schedule
  (`user_supplied`). Model recommendations, trader instructions and executions never overwrite it.
- **Metered** is derived from the *confirmed* state-of-charge change (telemetry/meter/manual),
  which overrides model- or execution-implied state. From a SoC delta and efficiencies:
  a fall in SoC is a discharge (`export = |ΔSoC|·η_discharge`), a rise is a charge
  (`import = |ΔSoC| / η_charge`).

**When it is paper, real or unavailable.** In a replay/trader session with both a contracted
position and confirmed delivery, the imbalance is `status = "paper"` — never a final BSC
settlement result. On the Elexon/market-only Market view there is no private contract or metering,
so `status = "unavailable"` (null fields + reason); nothing is fabricated. The recommendation or
instruction alone can never produce a settled imbalance.

### 2. GB System Imbalance (NIV)

Uses the official Elexon Net Imbalance Volume from the settlement system-prices dataset:

```text
NIV > +tolerance  → GB SYSTEM SHORT
NIV < −tolerance  → GB SYSTEM LONG
otherwise         → BALANCED
```

This is independent of the battery's Commercial Imbalance — the two may point the same way or
opposite ways, and all four combinations are supported and tested.

### 3. System Frequency

The physical grid frequency in Hz, separate from both imbalance concepts. Acquired at high
resolution (Elexon `/system/frequency`, ~15 s samples), normalised to UTC, cached, and aggregated
to the selected Settlement Period before display — the raw sub-minute series is never shipped
whole. Exposed fields: latest / mean / min / max frequency, deviation from 50 Hz, seconds below
49.9 and above 50.1, observation count and window bounds. NaN/Inf and out-of-range samples are
scrubbed before aggregation.

For `synthetic`/`sample` the frequency is a deterministic, reproducible, plausible generated series
(a seeded mean-reverting walk around 50 Hz), labelled `synthetic`/`sample`. It is **not** a
mechanical transform of NIV. On an Elexon failure the frequency block is returned as unavailable
(null + warning) — never a silent synthetic fallback — and the rest of the page keeps working.

### Indicative Imbalance Cashflow

```text
indicative_imbalance_cashflow_gbp = commercial_imbalance_mwh × system_price_gbp_per_mwh
```

The signed result is stored as-is (no sign flipping for aesthetics) and tested for positive and
negative prices and LONG/SHORT positions. It is **indicative only**: it ignores dual imbalance
pricing, accepted balancing actions and BSC settlement detail, and is never labelled final revenue.

### Partial responses

`GET /api/market/balance` returns four independent, individually-nullable blocks (system,
frequency, commercial, battery). A failure in one block never fails the whole response: the
unavailable block is `null` with a warning and the rest is still served (no HTTP 500 for a missing
subsection).
