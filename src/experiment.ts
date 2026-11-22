import { type Group, type Row, summarize } from "./analytics.ts";
import type { Platform } from "./templates/types.ts";

/**
 * "Do more of what works." Results in the analytics ledger become weights for
 * captions, sounds and template variants; the batch planner then gives better
 * performers more posts while always keeping a share for exploration, so new
 * ideas still get tried and an early fluke cannot take over.
 */
export type Dimension = "caption" | "audio_id" | "template_variant" | "count_tier";
export const DIMENSIONS: Dimension[] = ["caption", "audio_id", "template_variant", "count_tier"];
export type Weights = Partial<Record<Dimension, Record<string, number>>>;

export interface ExperimentConfig {
  /** share of posts spread evenly across all options regardless of results (0..1) */
  explore: number;
  /** an option needs this many posts with data before its results count */
  minPosts: number;
  weights: Record<Platform, Weights>;
}

/**
 * Score of one option relative to its platform: the average of whichever of
 * these are available, each divided by the platform-wide figure —
 * average views, viewed (not swiped) rate, average watch %, followers per
 * 1,000 views. 1.0 = platform average.
 */
export function relativeScore(g: Group, base: Group): number | null {
  const pairs: [number | null, number | null][] = [
    [g.avgViews, base.avgViews],
    [g.avgViewedRate, base.avgViewedRate],
    [g.avgWatchPct, base.avgWatchPct],
    [g.followersPer1kViews, base.followersPer1kViews],
  ];
  const ratios = pairs.filter(([a, b]) => a !== null && b !== null && b > 0).map(([a, b]) => a! / b!);
  return ratios.length ? ratios.reduce((x, y) => x + y, 0) / ratios.length : null;
}

export interface Ranked {
  option: string;
  posts: number;
  score: number | null;
  weight: number;
}

/**
 * Weights for one dimension on one platform. `options` is everything currently
 * configured, so brand-new options (no data yet) are included: they get the
 * same weight as an average performer, which is how new ideas enter the mix.
 */
export function recommend(rows: Row[], platform: Platform, by: Dimension, options: string[], cfg: Pick<ExperimentConfig, "explore" | "minPosts">): Ranked[] {
  const mine = rows.filter((r) => r.platform === platform);
  const base = summarize(mine, "platform")[0];
  const groups = new Map(summarize(mine, by).map((g) => [g.key.split(" · ").slice(1).join(" · "), g]));
  const scored = options.map((option) => {
    const g = groups.get(option);
    const enough = !!g && g.withData >= cfg.minPosts;
    return { option, posts: g?.withData ?? 0, score: enough && base ? relativeScore(g!, base) : null };
  });
  // unknown options count as average (1.0); clamp so one outlier cannot dominate
  const raw = scored.map((s) => Math.min(3, Math.max(0.2, s.score ?? 1)));
  const total = raw.reduce((a, b) => a + b, 0);
  return scored
    .map((s, i) => ({ ...s, score: s.score === null ? null : +s.score.toFixed(2), weight: +(cfg.explore / options.length + ((1 - cfg.explore) * raw[i]) / total).toFixed(4) }))
    .sort((a, b) => b.weight - a.weight);
}

/**
 * How many of n posts each option gets (largest-remainder rounding).
 * No weights = as even as possible. Options missing from `weights` get the
 * average weight, so newly added captions or sounds are tried straight away.
 */
export function apportion(options: string[], weights: Record<string, number> | undefined, n: number): number[] {
  const known = options.map((o) => weights?.[o]).filter((w): w is number => typeof w === "number" && w > 0);
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const w = options.map((o) => (weights?.[o] && weights[o] > 0 ? weights[o] : avg));
  const total = w.reduce((a, b) => a + b, 0);
  const exact = w.map((x) => (x / total) * n);
  const counts = exact.map(Math.floor);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; counts.reduce((a, b) => a + b, 0) < n; k++) counts[order[k % order.length][1]]++;
  return counts;
}

/**
 * Arrange a batch so no two factors move together.
 *
 * `counts[d][i]` is how many posts get option i of dimension d (caption,
 * sound, variant...). The search shuffles each dimension and keeps swaps that
 * make every pair of factors — including time slot and week — closer to
 * independent, and that avoid repeating the same option back-to-back.
 * Seeded, so the same inputs always give the same plan.
 * Returns assignment[d][k] = option index of dimension d for post k.
 */
export function design(n: number, perDay: number, counts: number[][], random: () => number): number[][] {
  const weeks = Math.max(1, Math.ceil(n / perDay / 7));
  const fixed = [
    { levels: perDay, of: (k: number) => k % perDay },
    { levels: weeks, of: (k: number) => Math.floor(k / perDay / 7) },
  ];
  const assign = counts.map((c) => {
    const a = c.flatMap((m, i) => Array<number>(m).fill(i));
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  });
  const table = (la: number, a: (k: number) => number, lb: number, b: (k: number) => number, ca: number[], cb: number[]) => {
    const t = new Float64Array(la * lb);
    for (let k = 0; k < n; k++) t[a(k) * lb + b(k)]++;
    let cost = 0;
    for (let i = 0; i < la; i++) for (let j = 0; j < lb; j++) cost += Math.pow(t[i * lb + j] - (ca[i] * cb[j]) / n, 2);
    return cost;
  };
  const marg = (levels: number, of: (k: number) => number) => {
    const m = Array<number>(levels).fill(0);
    for (let k = 0; k < n; k++) m[of(k)]++;
    return m;
  };
  const fixedMarg = fixed.map((f) => marg(f.levels, f.of));
  const cost = () => {
    let c = 0;
    for (let d = 0; d < assign.length; d++) {
      const get = (k: number) => assign[d][k];
      fixed.forEach((f, i) => (c += table(counts[d].length, get, f.levels, f.of, counts[d], fixedMarg[i])));
      for (let e = d + 1; e < assign.length; e++) c += table(counts[d].length, get, counts[e].length, (k) => assign[e][k], counts[d], counts[e]);
      for (let k = 1; k < n; k++) if (assign[d][k] === assign[d][k - 1] && counts[d].length > 2) c += 0.75;
    }
    return c;
  };
  let best = cost();
  for (let it = 0; it < 12000; it++) {
    const d = Math.floor(random() * assign.length);
    const i = Math.floor(random() * n);
    const j = Math.floor(random() * n);
    if (assign[d][i] === assign[d][j]) continue;
    [assign[d][i], assign[d][j]] = [assign[d][j], assign[d][i]];
    const c = cost();
    if (c <= best) best = c;
    else [assign[d][i], assign[d][j]] = [assign[d][j], assign[d][i]];
  }
  return assign;
}

