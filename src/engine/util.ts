import { createHash } from "node:crypto";

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Progress 0..1 of `t` through the window [t0, t0 + dur]. */
export const prog = (t: number, t0: number, dur: number) => clamp((t - t0) / dur);

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  return createHash("sha256").update(s).digest().readUInt32LE(0);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export const formatCount = (n: number) => Math.round(n).toLocaleString("en-US");

/** Dashboard-style compact number: 874, 13.6K, 346.6K, 3.6M, 1.2B */
export function shortCount(n: number): string {
  if (n >= 999.95e9) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 999.95e6) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 999950) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Watch-time style: 0.4, 10.5, 264, 4.5K */
export function shortHours(n: number): string {
  if (n >= 1000) return shortCount(n);
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(1);
}

export function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length) % arr.length];
}
