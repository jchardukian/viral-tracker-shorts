import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ROOT } from "./engine/draw.ts";
import { hashSeed, rng } from "./engine/util.ts";
import { addDays } from "./publish/schedule.ts";

export interface DayPoint {
  date: string;
  count: number;
  views28: number;
  watch28: number;
}

export interface HistoryConfig {
  /** first day of the time-lapse (count starts at 0) */
  startDate: string;
  /** the count is `currentCount` on this date */
  asOf: string;
  currentCount: number;
  /** average growth per day after `asOf` */
  dailyGrowth: number;
  /** optional CSV of real exported numbers: date,count,views28,watch_hours28 */
  history?: string | null;
  /** change to get a differently shaped simulated curve */
  historySeed?: string;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * Simulated growth curve from 0 on startDate to currentCount on asOf, then
 * dailyGrowth per day. Shaped like real small-channel growth: a slow start,
 * flat stretches, and a handful of viral spikes. 28-day views and watch time
 * are a rolling window over simulated daily views, so they rise and fall.
 */
export function simulateHistory(cfg: HistoryConfig, endDate: string): DayPoint[] {
  const r = rng(hashSeed(`history|${cfg.historySeed ?? cfg.startDate}|${cfg.currentCount}`));
  const nAsOf = Math.max(30, dayDiff(cfg.startDate, cfg.asOf));
  const n = Math.max(nAsOf, dayDiff(cfg.startDate, endDate));
  const w = new Float64Array(nAsOf + 1);
  const bursts = Array.from({ length: 5 + Math.floor(r() * 3) }, () => ({
    c: (0.18 + r() * 0.8) * nAsOf,
    wd: 2 + r() * 9,
    h: 4 + r() * 30,
  }));
  for (let d = 1; d <= nAsOf; d++) {
    const ramp = Math.pow(d / nAsOf, 1.6);
    let v = (0.05 + ramp) * (0.4 + r() * 1.2);
    for (const b of bursts) v += b.h * ramp * Math.exp(-Math.pow((d - b.c) / b.wd, 2));
    w[d] = v;
  }
  const total = w.reduce((a, b) => a + b, 0);
  const gains: number[] = [0];
  let acc = 0;
  let prev = 0;
  for (let d = 1; d <= nAsOf; d++) {
    acc += w[d];
    const c = Math.round((acc / total) * cfg.currentCount);
    gains.push(c - prev);
    prev = c;
  }
  for (let d = nAsOf + 1; d <= n; d++) gains.push(Math.max(1, Math.round(cfg.dailyGrowth * (0.55 + r() * 0.9))));

  const out: DayPoint[] = [];
  const dailyViews: number[] = [];
  let count = 0;
  let window = 0;
  for (let d = 0; d <= n; d++) {
    count += gains[d];
    dailyViews.push(Math.round(gains[d] * (70 + r() * 110) + count * (0.2 + r() * 0.5)));
    window += dailyViews[d] - (d >= 28 ? dailyViews[d - 28] : 0);
    out.push({ date: addDays(cfg.startDate, d), count, views28: window, watch28: window * 0.00125 * (0.94 + r() * 0.12) });
  }
  return out;
}

/** Real numbers exported by the owner. Header row required: date,count,views28,watch_hours28 */
export function loadHistoryCsv(path: string, endDate: string): DayPoint[] {
  const file = isAbsolute(path) ? path : join(ROOT, path);
  if (!existsSync(file)) throw new Error(`history file not found: ${path}`);
  const rows = readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1);
  const pts = rows
    .map((l) => l.split(",").map((s) => s.trim()))
    .filter((c) => c.length >= 4 && /^\d{4}-\d{2}-\d{2}$/.test(c[0]))
    .map((c) => ({ date: c[0], count: Number(c[1]), views28: Number(c[2]), watch28: Number(c[3]) }))
    .filter((p) => p.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length < 10) throw new Error(`${path}: need at least 10 dated rows on or before ${endDate}`);
  return pts;
}

export function historyFor(cfg: HistoryConfig, endDate: string): { points: DayPoint[]; source: "simulated" | "history" } {
  return cfg.history
    ? { points: loadHistoryCsv(cfg.history, endDate), source: "history" }
    : { points: simulateHistory(cfg, endDate), source: "simulated" };
}
