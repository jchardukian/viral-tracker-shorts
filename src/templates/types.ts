import type { Ctx, Rect } from "../engine/draw.ts";

export type Platform = "youtube" | "tiktok";
export const PLATFORMS: Platform[] = ["youtube", "tiktok"];

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;

export interface AudioAssignment {
  soundId: string | null;
  /** embedded = audio file muxed in; silent = silent AAC track (native sound or none) */
  mode: "embedded" | "silent";
  file: string | null;
  bpm: number;
  beatOffsetSec: number;
  /** explicit beat timestamps (sec); overrides the bpm grid when present */
  beats?: number[];
  /** why this mode was chosen (license state etc.) — copied to the manifest */
  note: string;
  link: string | null;
}

export interface ContentCard {
  title: string;
  age: string;
  views: number;
  likes: number;
  comments: number;
}

/** One "day" of the dashboard: everything drawn for a single cut of the time-lapse. */
export interface Snapshot {
  date: string;
  /** subscribers (YouTube) / followers (TikTok) */
  count: number;
  views28: number;
  watch28: number;
  /** headline metrics are up versus the previous period */
  up: boolean;
  /** status-bar clock of the "screenshot" */
  clock: string;
  latest: ContentCard & {
    expanded: boolean;
    note: string | null;
    rank: number;
    avgPct: number;
    /** per-row trend: 1 up, 0 flat, -1 down (views, avg % viewed, likes) */
    trend: [number, number, number];
  };
  older: ContentCard[];
  /** TikTok-only headline metrics */
  delta7: number;
  profileViews: number;
  likesTotal: number;
  shares: number;
}

export interface VideoSpec {
  id: string;
  platform: Platform;
  /** template variant name, e.g. dashboard / analytics / profile */
  variant: string;
  seed: number;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  frames: number;
  profile: { name: string; handle: string; initial: string; avatar: [string, string]; avatarImage?: string | null };
  /** set while rendering post thumbnails, so thumbnails do not nest */
  noThumbs?: boolean;
  /** which final-count size this video shows (e.g. 300, 1M, 1B); null when not tiered */
  countTier: string | null;
  /** one static caption for the whole video, like the reference */
  caption: string;
  snapshots: Snapshot[];
  /** first frame of each snapshot (same length as snapshots) */
  cuts: number[];
  /** frame at which the final snapshot starts its hold */
  holdFrame: number;
  startCount: number;
  endCount: number;
  beats: number[];
  audio: AudioAssignment;
  /** where the numbers come from: generated curve or the owner's exported history */
  dataSource: "simulated" | "history";
  /** small on-screen note that the numbers are an animation, or null to hide */
  disclosure: string | null;
}

export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** platform action-button rail on the right edge */
  rail: { x: number; y0: number; y1: number };
}

export interface Template {
  platform: Platform;
  safe: SafeArea;
  /** bounding boxes of the elements that must stay readable under the player UI */
  layout: Record<string, Rect>;
  render(ctx: Ctx, spec: VideoSpec, t: number): void;
}

/** Index of the snapshot on screen at frame f (hard cuts, no blending). */
export function snapshotIndex(spec: VideoSpec, f: number): number {
  let lo = 0;
  let hi = spec.cuts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spec.cuts[mid] <= f) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const frameOf = (spec: VideoSpec, t: number) => Math.min(spec.frames - 1, Math.max(0, Math.floor(t * spec.fps + 1e-6)));

export function rectInSafe(r: Rect, s: SafeArea): boolean {
  const inside = r.x >= s.left && r.x + r.w <= s.right && r.y >= s.top && r.y + r.h <= s.bottom;
  const hitsRail = r.x + r.w > s.rail.x && r.y + r.h > s.rail.y0 && r.y < s.rail.y1;
  return inside && !hitsRail;
}
