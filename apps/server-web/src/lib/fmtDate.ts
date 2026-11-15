/** ISO 时间戳的日期部分；没有值时回 fallback（例如「—」「永久」「从未」）。 */
export function fmtDate(iso: string | null, fallback: string): string {
  return iso ? iso.slice(0, 10) : fallback;
}
