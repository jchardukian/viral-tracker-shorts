import type { Ctx, Rect } from "../engine/draw.ts";
import { clamp, easeOutCubic, lerp, prog } from "../engine/util.ts";

export type Platform = "youtube" | "tiktok";
export const PLATFORMS: Platform[] = ["youtube", "tiktok"];

export const WIDTH = 1080;
export const HEIGHT = 1920;
export const FPS = 30;

export interface CounterStep {
  /** start time (sec) */
  t: number;
  dur: number;
  from: number;
  to: number;
  /** true for the single +1 triggered by the on-screen CTA tap */
  tap?: boolean;
}

export interface Caption {
  t0: number;
  t1: number;
  text: string;
}

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

export interface VideoSpec {
  id: string;
  platform: Platform;
  seed: number;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  frames: number;
  profile: { name: string; handle: string; initial: string; avatar: [string, string] };
  theme: string;
  goal: number;
  /** tracker bar spans [trackFrom, goal] */
  trackFrom: number;
  startCount: number;
  endCount: number;
  steps: CounterStep[];
  captions: Caption[];
  tapAt: number;
  beats: number[];
  extras: { following: number; likes: number };
  audio: AudioAssignment;
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
  /** bounding boxes of every critical element; tested against `safe` */
  layout: Record<string, Rect>;
  themes: string[];
  render(ctx: Ctx, spec: VideoSpec, t: number): void;
}

/** Counter value at time t. Fractional while a step is rolling. */
export function countAt(spec: VideoSpec, t: number): number {
  let v = spec.startCount;
  for (const s of spec.steps) {
    if (t < s.t) break;
    v = lerp(s.from, s.to, easeOutCubic(prog(t, s.t, s.dur)));
  }
  return v;
}

/** 0..1 decaying pulse after the most recent beat. */
export function beatPulse(spec: VideoSpec, t: number): number {
  let last = -1;
  for (const b of spec.beats) {
    if (b <= t) last = b;
    else break;
  }
  return last < 0 ? 0 : Math.exp(-(t - last) * 7);
}

export function captionAt(spec: VideoSpec, t: number): Caption | null {
  return spec.captions.find((c) => t >= c.t0 && t < c.t1) ?? null;
}

/** Fraction of the tracker bar filled, including the intro sweep from empty. */
export function trackerFill(spec: VideoSpec, t: number): number {
  const real = clamp((countAt(spec, t) - spec.trackFrom) / (spec.goal - spec.trackFrom));
  return real * easeOutCubic(prog(t, 0.25, 1.1));
}

export function rectInSafe(r: Rect, s: SafeArea): boolean {
  const inside =
    r.x >= s.left && r.x + r.w <= s.right && r.y >= s.top && r.y + r.h <= s.bottom;
  const hitsRail = r.x + r.w > s.rail.x && r.y + r.h > s.rail.y0 && r.y < s.rail.y1;
  return inside && !hitsRail;
}
