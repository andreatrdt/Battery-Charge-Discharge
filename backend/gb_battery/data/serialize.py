"""JSON-safe serialisation for pandas/NumPy values.

FastAPI's default encoder happily emits bare ``NaN`` / ``Infinity`` tokens,
which are invalid JSON that many strict clients reject — and pandas frames are
full of ``NaN`` / ``NaT`` / ``pd.NA`` once any source is missing. Every API
payload that originates from a DataFrame or NumPy computation is passed through
:func:`json_safe`, which recursively converts:

* ``NaN`` / ``+Inf`` / ``-Inf``           → ``None``
* ``pd.NaT`` / ``pd.NA`` / ``None``        → ``None``
* NumPy scalar types (``int64``/``float64``/``bool_``) → native Python
* ``datetime`` / ``date`` / ``pd.Timestamp`` → ISO-8601 string

into values the standard JSON encoder accepts.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from typing import Any

import numpy as np
import pandas as pd


def json_safe(obj: Any) -> Any:  # noqa: PLR0911 — a flat type dispatch reads clearest
    """Recursively convert ``obj`` into JSON-serialisable, finite values."""
    # Fast path for the common scalars.
    if obj is None:
        return None
    if isinstance(obj, bool):  # before int (bool is an int subclass)
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None

    # pandas / NumPy missing-value sentinels.
    if obj is pd.NaT or obj is pd.NA:
        return None
    # ``pd.isna`` raises on array-likes, so guard to scalars.
    if np.isscalar(obj):
        try:
            if pd.isna(obj):  # covers np.nan, NaT, NA for scalars
                return None
        except (TypeError, ValueError):
            pass

    # NumPy scalar types.
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        v = float(obj)
        return v if math.isfinite(v) else None
    if isinstance(obj, np.bool_):
        return bool(obj)

    # Timestamps / dates.
    if isinstance(obj, pd.Timestamp):
        return None if pd.isna(obj) else obj.isoformat()
    if isinstance(obj, datetime | date):
        return obj.isoformat()

    # Containers.
    if isinstance(obj, Mapping):
        return {str(k): json_safe(v) for k, v in obj.items()}
    if isinstance(obj, np.ndarray):
        return [json_safe(v) for v in obj.tolist()]
    if isinstance(obj, str | bytes):
        return obj.decode() if isinstance(obj, bytes) else obj
    if isinstance(obj, Sequence):
        return [json_safe(v) for v in obj]

    return obj


def frame_to_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    """Convert a DataFrame to a list of JSON-safe row dicts.

    Handles the whole NaN/Inf/NaT/NA/NumPy-scalar/timestamp surface in one place,
    so callers never hand a bare ``NaN`` to the JSON encoder.
    """
    if frame.empty:
        return []
    clean = frame.replace([np.inf, -np.inf], np.nan)
    records = clean.astype(object).where(pd.notna(clean), None).to_dict(orient="records")
    return [json_safe(r) for r in records]
