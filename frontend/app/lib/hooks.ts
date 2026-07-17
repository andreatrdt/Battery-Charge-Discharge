"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type OptimisationResult } from "./api";
import { useAppState } from "./store";

export function useOptimise(mode = "deterministic", extra: Record<string, unknown> = {}) {
  const { config, day, source, offline } = useAppState();
  const [result, setResult] = useState<OptimisationResult | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.optimise({ config, day, source, offline, mode, ...extra });
      setResult(res.result);
      setWarnings(res.snapshot?.warnings || res.result.warnings || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(config), day, source, offline, mode, JSON.stringify(extra)]);

  useEffect(() => {
    run();
  }, [run]);

  return { result, warnings, loading, error, run };
}
