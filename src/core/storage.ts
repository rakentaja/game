const PREFIX = 'inkwake:';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

/** Daily Issue best time (s) for a YYYYMMDD key, or null. */
export function loadDailyBest(dateKey: string): number | null {
  const v = load<{ bestTimeS: number | null }>(`daily:${dateKey}`, { bestTimeS: null }).bestTimeS;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Store a finished Daily Issue time; keeps the best. Returns the best and whether it improved. */
export function recordDailyBest(dateKey: string, timeS: number): { best: number; improved: boolean } {
  const prev = loadDailyBest(dateKey);
  const improved = prev === null || timeS < prev;
  const best = improved ? timeS : prev;
  if (improved) save(`daily:${dateKey}`, { bestTimeS: best });
  return { best, improved };
}

export function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / quota) — game continues without persistence */
  }
}
