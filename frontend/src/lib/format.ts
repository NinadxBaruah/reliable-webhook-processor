export function formatTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleTimeString(undefined, { hour12: false }) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

export function formatDuration(startIso: string, endIso: string | null): string {
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = end - new Date(startIso).getTime();
  const text = ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  return endIso ? text : `${text}…`;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
