"""DuckDB persistence for completed replay runs.

A backend restart must not destroy completed research runs. On completion (or
whenever the API asks), the full run — options, config, versions, decisions,
forecast vintages and computed metrics — is written to
``<cache_dir>/replays.duckdb`` as JSON documents keyed by ``replay_id``.

Restored runs are read-only: status, decisions, forecasts and cached metrics
are served from storage. Endpoints that need live re-solves (alternatives,
fresh benchmark runs) require a live session and say so.
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
)
"""


class ReplayArchive:
    def __init__(self, settings: DataSettings | None = None) -> None:
        self.settings = settings or get_settings()
        self._path = str(self.settings.ensure_cache_dir() / "replays.duckdb")
        con = duckdb.connect(self._path)
        con.execute(SCHEMA)
        con.close()

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
