import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./engine/draw.ts";
import { hashSeed, rng } from "./engine/util.ts";
import { tiktokTemplate } from "./templates/tiktok.ts";
import {
  type AudioAssignment,
  type Caption,
  type CounterStep,
  FPS,
  HEIGHT,
  type Platform,
  type Template,
  type VideoSpec,
  WIDTH,
} from "./templates/types.ts";
import { youtubeTemplate } from "./templates/youtube.ts";

export const TEMPLATES: Record<Platform, Template> = { youtube: youtubeTemplate, tiktok: tiktokTemplate };

export interface ChannelConfig {
  name: string;
  handle: string;
  initial: string;
  avatar: [string, string];
  goal: number;
  trackFrom: number;
  startCount: number;
  /** share of the visible tracker range gained during one video */
  gainFrac: number;
  following?: number;
  likes?: number;
  bufferChannelId: string | null;
  youtubeCategoryId?: string;
}

export interface CaptionConfig {
  sets: string[][];
  titles: string[];
  description: string;
}

export const readJson = <T>(rel: string): T => JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;

export function loadChannels() {
  return readJson<{ disclosure: string | null } & Record<Platform, ChannelConfig>>("config/channels.json");
}
export function loadCaptions() {
  return readJson<Record<Platform, CaptionConfig>>("config/captions.json");
}

export interface SpecInput {
  id: string;
  platform: Platform;
  channel: ChannelConfig;
  captions: string[];
  audio: AudioAssignment;
  theme?: string;
  startCount?: number;
  trackFrom?: number;
  gainFrac?: number;
  disclosure?: string | null;
  /** target length; snapped to a whole number of 4-beat bars */
  targetSec?: number;
}

/** Deterministic: the same input always yields the same spec (and the same pixels). */
export function buildSpec(input: SpecInput): VideoSpec {
  const { platform, channel, audio } = input;
  const seed = hashSeed(`${input.id}|${platform}`);
  const r = rng(seed);
  const interval = 60 / audio.bpm;

  // beat grid: explicit timestamps win, otherwise bpm + offset
  let beats: number[];
  let durationSec: number;
  if (audio.beats && audio.beats.length >= 8) {
    beats = [...audio.beats].sort((a, b) => a - b);
    durationSec = beats[beats.length - 1] + interval;
  } else {
    const bars = Math.max(2, Math.round((input.targetSec ?? 8.4) / (interval * 4)));
    const n = bars * 4;
    beats = Array.from({ length: n }, (_, i) => +(audio.beatOffsetSec + i * interval).toFixed(4));
    durationSec = audio.beatOffsetSec + n * interval;
  }
  const frames = Math.round(durationSec * FPS);
  durationSec = frames / FPS;

  const goal = channel.goal;
  const trackFrom = input.trackFrom ?? channel.trackFrom;
  const startCount = input.startCount ?? channel.startCount;
  const gainFrac = input.gainFrac ?? channel.gainFrac;
  if (!(trackFrom <= startCount && startCount < goal)) throw new Error(`${input.id}: need trackFrom <= startCount < goal`);

  // counter steps land on beats; the CTA tap adds exactly +1
  const tapBeat = beats[Math.min(beats.length - 3, Math.round(beats.length * 0.68))];
  const stepBeats = beats.filter((b) => b >= 0.85 && b !== tapBeat && b < durationSec - 0.45 && r() < 0.86);
  const budget = Math.max(stepBeats.length, Math.min((goal - trackFrom) * gainFrac, goal - startCount - 2));
  const weights = stepBeats.map(() => 0.35 + r());
  const wsum = weights.reduce((a, b) => a + b, 0);
  const stepDur = Math.min(0.34, interval * 0.62);
  const steps: CounterStep[] = [];
  let v = startCount;
  const push = (t: number, inc: number, dur: number, tap = false) => {
    if (v + inc >= goal) inc = Math.max(0, goal - 1 - v);
    if (inc <= 0) return;
    steps.push({ t, dur, from: v, to: v + inc, ...(tap ? { tap } : {}) });
    v += inc;
  };
  const tapAt = tapBeat;
  const events = [
    ...stepBeats.map((t, i) => ({ t, inc: Math.max(1, Math.round((budget * weights[i]) / wsum)), dur: stepDur, tap: false })),
    { t: +(tapAt + 0.1).toFixed(4), inc: 1, dur: 0.22, tap: true },
  ].sort((x, y) => x.t - y.t);
  for (const e of events) push(e.t, e.inc, e.dur, e.tap);

  // captions change on bar lines
  const lines = input.captions;
  const captions: Caption[] = lines.map((text, i) => {
    const b0 = Math.round((beats.length * i) / lines.length / 2) * 2;
    const b1 = Math.round((beats.length * (i + 1)) / lines.length / 2) * 2;
    return {
      text,
      t0: i === 0 ? 0.35 : beats[b0],
      t1: i === lines.length - 1 ? durationSec + 1 : beats[b1],
    };
  });

  const tpl = TEMPLATES[platform];
  const theme = input.theme ?? tpl.themes[Math.floor(r() * tpl.themes.length)];
  return {
    id: input.id,
    platform,
    seed,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    durationSec,
    frames,
    profile: { name: channel.name, handle: channel.handle, initial: channel.initial, avatar: channel.avatar },
    theme,
    goal,
    trackFrom,
    startCount,
    endCount: v,
    steps,
    captions,
    tapAt,
    beats,
    extras: { following: channel.following ?? 0, likes: channel.likes ?? 0 },
    audio,
    disclosure: input.disclosure === undefined ? "simulated counter · animation" : input.disclosure,
  };
}
