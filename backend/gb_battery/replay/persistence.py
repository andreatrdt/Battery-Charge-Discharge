"""DuckDB persistence for replay runs and their append-only audit trail.

Two complementary stores, both in ``<cache_dir>/replays.duckdb``:

* ``replay_runs`` — a snapshot document per run (options, config, versions,
  decisions, vintages, metrics). Written when a session is created and
  refreshed as it progresses, so a completed run survives a restart.
* ``replay_transitions`` — the **append-only audit trail**. Every state
  transition of the trader-in-the-loop machine (recommendation, trader
  instruction, execution, physical-state confirmation, advance/supersession) is
  appended with a monotonic sequence number and never updated or deleted.

The transition log is what makes an *active* (mid-flight) session recoverable:
because every stage is deterministic given its recorded inputs, replaying the
log rebuilds the engine exactly — including the in-progress gate — after a
process restart. Historical rows are never mutated; recovery only reads them.
"""

from __future__ import annotations

import contextlib
import json
from datetime import UTC, datetime

import duckdb

from gb_battery.data.settings import DataSettings, get_settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS replay_runs (
    replay_id       VARCHAR PRIMARY KEY,
    created_at      TIMESTAMPTZ,
    saved_at        TIMESTAMPTZ,
    mode            VARCHAR,
    day             VARCHAR,
    n_days          INTEGER,
    complete        BOOLEAN,
    options_json    VARCHAR,
    config_json     VARCHAR,
    versions_json   VARCHAR,
    summary_json    VARCHAR,
    decisions_json  VARCHAR,
    vintages_json   VARCHAR,
    metrics_json    VARCHAR
);
CREATE TABLE IF NOT EXISTS replay_transitions (
    replay_id       VARCHAR,
    seq             INTEGER,
    at_utc          TIMESTAMPTZ,
    transition      VARCHAR,
    step            INTEGER,
    data_json       VARCHAR,
    PRIMARY KEY (replay_id, seq)
);
"""


class ReplayArchive:
    """Best-effort archive. Persistence must never break a running replay.

    DuckDB allows a single writer process per file, so a second backend (or a
    stale one) can legitimately fail to open the database. In that case the
    archive degrades to a disabled no-op — replays keep working in memory and
    ``unavailable_reason`` explains why nothing is being persisted — instead of
    turning every replay endpoint into a 500.
    """

    def __init__(self, settings: DataSettings | None = None) -> None:
        self.settings = settings or get_settings()
        self._path = str(self.settings.ensure_cache_dir() / "replays.duckdb")
        self.available = False
        self.unavailable_reason: str | None = None
        try:
            con = duckdb.connect(self._path)
            try:
                # Multiple DDL statements: DuckDB executes one per call. Existing
                # databases simply gain the new table (CREATE ... IF NOT EXISTS).
                for stmt in filter(None, (s.strip() for s in SCHEMA.split(";"))):
                    con.execute(stmt)
            finally:
                con.close()
            self.available = True
        except Exception as exc:  # noqa: BLE001 — degrade, never raise
            self.unavailable_reason = (
                f"Replay persistence is disabled: {self._path} could not be opened "
                f"({exc}). Runs will work in memory but will not survive a restart."
            )

    # -------------------------------------------------- append-only audit log
    def append_transition(
        self, replay_id: str, transition: str, step: int, data: dict, at: datetime | None = None
    ) -> int:
        """Append one immutable state transition; returns its sequence number.

        Never updates or deletes an existing row — the log is the audit trail.
        """
        if not self.available:
            return -1
        try:
            con = duckdb.connect(self._path)
            try:
                row = con.execute(
                    "SELECT COALESCE(MAX(seq), -1) FROM replay_transitions WHERE replay_id = ?",
                    [replay_id],
                ).fetchone()
                seq = int(row[0]) + 1 if row else 0
                con.execute(
                    "INSERT INTO replay_transitions VALUES (?, ?, ?, ?, ?, ?)",
                    [replay_id, seq, at or datetime.now(tz=UTC), transition, step, json.dumps(data)],
                )
                return seq
            finally:
                con.close()
        except Exception:  # noqa: BLE001 — audit logging must never break a replay
            return -1

    def load_transitions(self, replay_id: str) -> list[dict]:
        """Read the append-only transition log in order."""
        if not self.available:
            return []
        try:
            con = duckdb.connect(self._path, read_only=True)
            try:
                rows = con.execute(
                    "SELECT seq, at_utc, transition, step, data_json FROM replay_transitions "
                    "WHERE replay_id = ? ORDER BY seq",
                    [replay_id],
                ).fetchall()
            finally:
                con.close()
        except Exception:  # noqa: BLE001
            return []
        return [
            {
                "seq": r[0],
                "at": r[1].isoformat() if r[1] else None,
                "transition": r[2],
                "step": r[3],
                "data": json.loads(r[4]) if r[4] else {},
            }
            for r in rows
        ]

    # ------------------------------------------------------------------ write
    def save(
        self,
        *,
        replay_id: str,
        created_at: datetime,
        mode: str,
        day: str,
        n_days: int,
        complete: bool,
        options: dict,
        config: dict,
        versions: dict,
        summary: dict,
        decisions: list[dict],
        vintages: list[dict],
        metrics: dict | None = None,
    ) -> bool:
        """Upsert a run; best-effort (returns False instead of raising)."""
        if not self.available:
            return False
        try:
            con = duckdb.connect(self._path)
            try:
                con.execute("DELETE FROM replay_runs WHERE replay_id = ?", [replay_id])
                con.execute(
                    "INSERT INTO replay_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        replay_id,
                        created_at,
                        datetime.now(tz=UTC),
                        mode,
                        day,
                        n_days,
                        complete,
                        json.dumps(options),
                        json.dumps(config),
                        json.dumps(versions),
                        json.dumps(summary),
                        json.dumps(decisions),
                        json.dumps(vintages),
                        json.dumps(metrics) if metrics is not None else None,
                    ],
                )
            finally:
                con.close()
            return True
        except Exception:  # noqa: BLE001 — persistence must never break a replay
            return False

    def update_metrics(self, replay_id: str, metrics: dict) -> None:
        if not self.available:
            return
        with contextlib.suppress(Exception):
            con = duckdb.connect(self._path)
            try:
                con.execute(
                    "UPDATE replay_runs SET metrics_json = ? WHERE replay_id = ?",
                    [json.dumps(metrics), replay_id],
                )
            finally:
                con.close()

    # ------------------------------------------------------------------- read
    def load(self, replay_id: str) -> dict | None:
        if not self.available:
            return None
        try:
            con = duckdb.connect(self._path, read_only=True)
            try:
                row = con.execute(
                    "SELECT * FROM replay_runs WHERE replay_id = ?", [replay_id]
                ).fetchone()
                cols = [d[0] for d in con.description]
            finally:
                con.close()
        except Exception:  # noqa: BLE001
            return None
        if row is None:
            return None
        rec = dict(zip(cols, row, strict=True))
        for key in ("options", "config", "versions", "summary", "decisions", "vintages", "metrics"):
            raw = rec.pop(f"{key}_json", None)
            rec[key] = json.loads(raw) if raw else None
        return rec

    def list_runs(self, limit: int = 50) -> list[dict]:
        if not self.available:
            return []
        try:
            con = duckdb.connect(self._path, read_only=True)
            try:
                rows = con.execute(
                    "SELECT replay_id, created_at, saved_at, mode, day, n_days, complete, summary_json "
                    "FROM replay_runs ORDER BY saved_at DESC LIMIT ?",
                    [limit],
                ).fetchall()
            finally:
                con.close()
        except Exception:  # noqa: BLE001
            return []
        out = []
        for r in rows:
            out.append(
                {
                    "replay_id": r[0],
                    "created_at": r[1].isoformat() if r[1] else None,
                    "saved_at": r[2].isoformat() if r[2] else None,
                    "mode": r[3],
                    "day": r[4],
                    "n_days": r[5],
                    "complete": r[6],
                    "summary": json.loads(r[7]) if r[7] else None,
                }
            )
        return out


_archive: ReplayArchive | None = None


def get_archive() -> ReplayArchive:
    global _archive  # noqa: PLW0603
    if _archive is None:
        _archive = ReplayArchive()
    return _archive
