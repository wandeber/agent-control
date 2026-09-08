/** A selection always retains one run; a plain click replaces the whole set. */
export function nextRunSelection(current: string[], runId: string, additive: boolean): string[] {
  if (!additive) return [runId];
  if (!current.includes(runId)) return [...current, runId];
  return current.length > 1 ? current.filter(id => id !== runId) : current;
}

export function readRunSelection(search: string, embedded: boolean): string[] {
  const ids = [...new Set(new URLSearchParams(search).getAll("run_id").map(id => id.trim()).filter(Boolean))];
  return embedded ? ids.slice(0, 1) : ids;
}

export function runSelectionKey(ids: string[]): string {
  return JSON.stringify([...ids].sort());
}
