import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./engine/draw.ts";
import { hashSeed, pick, rng, shortCount } from "./engine/util.ts";
import { type DayPoint, type HistoryConfig, historyFor } from "./history.ts";
import { tiktokProfileTemplate } from "./templates/tiktok-profile.ts";
import { tiktokTemplate } from "./templates/tiktok.ts";
import { type AudioAssignment, type ContentCard, FPS, HEIGHT, type Platform, type Snapshot, type Template, type VideoSpec, WIDTH } from "./templates/types.ts";
import { youtubeTemplate } from "./templates/youtube.ts";

/** Template variants per platform; the first one is the default. */
export const TEMPLATES: Record<Platform, Record<string, Template>> = {
  youtube: { dashboard: youtubeTemplate },
  tiktok: { analytics: tiktokTemplate, profile: tiktokProfileTemplate },
};

export function templateFor(spec: Pick<VideoSpec, "platform" | "variant">): Template {
  const t = TEMPLATES[spec.platform][spec.variant];
  if (!t) throw new Error(`unknown ${spec.platform} template variant "${spec.variant}"`);
  return t;
}

export interface ChannelConfig extends HistoryConfig {
  name: string;
  handle: string;
  initial: string;
  avatar: [string, string];
  /** profile photo, relative to the repo root; falls back to the initial on a gradient */
  avatarImage?: string | null;
  /** template variants to rotate through; defaults to the platform's first */
  variants?: string[];
  bufferChannelId: string | null;
  youtubeCategoryId?: string;
}

/** A final-count size to test: each video ends somewhere between base and base x 1.6. */
export interface CountTier {
  id: string;
  base: number;
}

export interface CaptionConfig {
  /** on-screen caption; one is used, unchanged, for a whole video */
  captions: string[];
  /** titles of the simulated "latest content" cards */
  contentTitles: string[];
  titles: string[];
  description: string;
}

export const readJson = <T>(rel: string): T => JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;

export function loadChannels() {
  return readJson<{ disclosure: string | null; publishSilent?: boolean; countTiers?: CountTier[] } & Record<Platform, ChannelConfig>>("config/channels.json");
}
export function loadCaptions() {
  return readJson<Record<Platform, CaptionConfig>>("config/captions.json");
}

export interface SpecInput {
  id: string;
  platform: Platform;
  channel: ChannelConfig;
  /** template variant; defaults to the platform's first */
  variant?: string;
  caption: string;
  contentTitles: string[];
  audio: AudioAssignment;
  /** label of the final-count size being tested */
  countTier?: string | null;
  /** the time-lapse ends on this date (YYYY-MM-DD) */
  date: string;
  disclosure?: string | null;
  /** target length; snapped to whole 4-beat bars */
  targetSec?: number;
}

/**
 * Pacing measured from the reference recording (18.4 s, ~260 cuts):
 * hard cuts about every 2 frames at 30 fps, slowing over the last ~3 s,
 * then a ~2 s hold on the final dashboard before the loop restarts.
 */
const FAST = 2;
const TAIL = [3, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 9, 10, 12];
const HOLD_SEC = 2.0;

const NOTES = [
  "Nice! Views are about what you usually get.",
  "Great job! Views and watch time are higher than usual.",
  "Great job! You got more views and likes than usual.",
];

function ageText(r: () => number) {
  const h = 2 + Math.floor(r() * 70);
  const m = Math.floor(r() * 60);
  return h >= 24 ? `First ${Math.floor(h / 24)} days ${h % 24} hours` : `First ${h} hours ${m} minutes`;
}

function card(r: () => number, titles: string[], base: number): ContentCard {
  const views = Math.max(3, Math.round(base * (0.15 + r() * r() * 3)));
  const likes = Math.round(views * (0.012 + r() * 0.03));
  return { title: pick(r, titles), age: ageText(r), views, likes, comments: Math.round(likes * (0.1 + r() * 0.6)) };
}

function snapshot(r: () => number, p: DayPoint, prev: DayPoint | null, week: DayPoint | null, titles: string[]): Snapshot {
  const base = Math.max(40, p.views28 / 60);
  const latest = card(r, titles, base);
  const t = () => (r() < 0.45 ? 1 : r() < 0.5 ? 0 : -1);
  return {
    date: p.date,
    count: p.count,
    views28: p.views28,
    watch28: p.watch28,
    up: !!prev && p.views28 > prev.views28,
    clock: `${1 + Math.floor(r() * 12)}:${String(Math.floor(r() * 60)).padStart(2, "0")}`,
    latest: {
      ...latest,
      expanded: r() < 0.7,
      note: r() < 0.3 ? pick(r, NOTES) : null,
      rank: 1 + Math.floor(r() * 10),
      avgPct: +(40 + r() * 140).toFixed(1),
      trend: [t(), t(), t()],
    },
    older: [card(r, titles, base), card(r, titles, base)],
    delta7: p.count - (week?.count ?? 0),
    profileViews: Math.round(p.views28 * (0.01 + r() * 0.01)),
    likesTotal: Math.round(p.views28 * (0.03 + r() * 0.01)),
    shares: Math.round(latest.likes * (0.05 + r() * 0.2)),
  };
}

/** Deterministic: the same input always yields the same spec (and the same pixels). */
export function buildSpec(input: SpecInput): VideoSpec {
  const { platform, channel, audio } = input;
  const seed = hashSeed(`${input.id}|${platform}`);
  const r = rng(seed);
  const interval = 60 / audio.bpm;

  let beats: number[];
  let durationSec: number;
  if (audio.beats && audio.beats.length >= 8) {
    beats = [...audio.beats].sort((a, b) => a - b);
    durationSec = beats[beats.length - 1] + interval;
  } else {
    const bars = Math.max(3, Math.round((input.targetSec ?? 16) / (interval * 4)));
    beats = Array.from({ length: bars * 4 }, (_, i) => +(audio.beatOffsetSec + i * interval).toFixed(4));
    durationSec = audio.beatOffsetSec + bars * 4 * interval;
  }
  const frames = Math.round(durationSec * FPS);
  durationSec = frames / FPS;

  // cut schedule: fast run, slowing tail, final hold starting on a beat
  const target = durationSec - HOLD_SEC;
  const holdBeat = beats.reduce((best, b) => (Math.abs(b - target) < Math.abs(best - target) ? b : best), beats[0]);
  const holdFrame = Math.round(holdBeat * FPS);
  const tailFrames = TAIL.reduce((a, b) => a + b, 0);
  const nFast = Math.max(8, Math.floor((holdFrame - tailFrames) / FAST));
  const lens = [...Array(nFast).fill(FAST), ...TAIL];
  lens[0] += holdFrame - (nFast * FAST + tailFrames); // absorb rounding in the opening frame
  const cuts: number[] = [];
  let f = 0;
  for (const len of lens) {
    cuts.push(f);
    f += len;
  }
  cuts.push(holdFrame);
  const n = cuts.length;

  // pick n days out of the history, always ending on the final day
  const { points, source } = historyFor(channel, input.date);
  const snapshots: Snapshot[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i / (n - 1)) * (points.length - 1));
    snapshots.push(snapshot(r, points[idx], idx > 0 ? points[idx - 1] : null, points[idx - 7] ?? null, input.contentTitles));
  }

  return {
    id: input.id,
    platform,
    variant: input.variant ?? Object.keys(TEMPLATES[platform])[0],
    seed,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    durationSec,
    frames,
    profile: { name: channel.name, handle: channel.handle, initial: channel.initial, avatar: channel.avatar, avatarImage: channel.avatarImage ?? null },
    countTier: input.countTier ?? null,
    // {count} in a caption becomes this video's own final number, e.g. "1.3M"
    caption: input.caption.replace(/\{count\}/g, shortCount(snapshots[n - 1].count)),
    captionKey: input.caption,
    snapshots,
    cuts,
    holdFrame,
    startCount: snapshots[0].count,
    endCount: snapshots[n - 1].count,
    beats,
    audio,
    dataSource: source,
    disclosure: input.disclosure === undefined ? "simulated numbers" : input.disclosure,
  };
}
