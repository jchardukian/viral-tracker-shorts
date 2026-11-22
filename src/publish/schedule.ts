/** Offset (minutes east of UTC) of `timeZone` at the given instant. */
function tzOffsetMin(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** "2026-11-22" + "18:23" in America/Chicago -> "2026-11-22T18:23:00-06:00" (DST-aware). */
export function zonedIso(date: string, hhmm: string, timeZone: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let off = tzOffsetMin(new Date(guess), timeZone);
  off = tzOffsetMin(new Date(guess - off * 60000), timeZone); // settle across DST edges
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date}T${p(hh)}:${p(mm)}:00${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
