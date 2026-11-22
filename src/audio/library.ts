import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { ROOT } from "../engine/draw.ts";
import type { AudioAssignment, Platform } from "../templates/types.ts";
import { synthBeat } from "./synth.ts";

export type LicenseStatus = "owned" | "licensed" | "platform-native-only" | "unknown";

export interface Sound {
  id: string;
  title: string;
  /** platforms this sound has been approved for */
  approvedPlatforms: Platform[];
  /** link to the sound on the platform (reference / native attach); never downloaded */
  link: string | null;
  /** path to an audio file we are allowed to embed, relative to repo root */
  file: string | null;
  /** procedurally generate `file` if it does not exist (original audio, test use) */
  generator?:
    | { type: "synth"; seed: number; seconds: number }
    /** prompt kept so well-performing tracks can seed the next ones */
    | { type: "elevenlabs-music"; prompt: string; generatedAt: string; basedOn?: string };
  license: {
    status: LicenseStatus;
    /** true only when the file may be mixed into the MP4 and uploaded by a third-party tool */
    embedAllowed: boolean;
    /** licence id / invoice / URL of the grant */
    proof: string | null;
    notes?: string;
  };
  bpm: number;
  beatOffsetSec: number;
  /** optional explicit beat timestamps (sec); overrides bpm grid */
  beats?: number[];
  activeFrom: string;
  expiresAt: string;
}

export interface AudioLibrary {
  platform: Platform;
  sounds: Sound[];
}

export class AudioError extends Error {}

export function loadLibrary(platform: Platform, dir = join(ROOT, "config", "audio")): AudioLibrary {
  const lib = JSON.parse(readFileSync(join(dir, `${platform}.json`), "utf8")) as AudioLibrary;
  if (lib.platform !== platform) throw new AudioError(`${platform}.json declares platform "${lib.platform}"`);
  const ids = new Set<string>();
  for (const s of lib.sounds) {
    if (ids.has(s.id)) throw new AudioError(`duplicate sound id ${s.id}`);
    ids.add(s.id);
    if (!(s.bpm > 40 && s.bpm < 240)) throw new AudioError(`${s.id}: bpm out of range`);
  }
  return lib;
}

/** Sounds approved for this platform and inside their active window on `date` (YYYY-MM-DD). */
export function activeSounds(lib: AudioLibrary, date: string): Sound[] {
  return lib.sounds.filter(
    (s) => s.approvedPlatforms.includes(lib.platform) && s.activeFrom <= date && date <= s.expiresAt,
  );
}

/** Round-robin rotation across the active pool. */
export function pickSound(lib: AudioLibrary, date: string, index: number): Sound | null {
  const pool = activeSounds(lib, date);
  return pool.length ? pool[index % pool.length] : null;
}

const abs = (p: string) => (isAbsolute(p) ? p : join(ROOT, p));

/**
 * Decide how a sound is used for one video.
 *  - embeddable (owned/licensed + embedAllowed + file present) -> muxed into the MP4
 *  - link-only / native-only / unknown licence -> silent export; the manifest
 *    records the link so the sound can be attached natively in the app
 *  - embeddable but the file is missing -> hard error (never silently ship a
 *    video that was supposed to have music)
 */
export function resolveAudio(sound: Sound | null, platform: Platform): AudioAssignment {
  if (!sound)
    return { soundId: null, mode: "silent", file: null, bpm: 120, beatOffsetSec: 0, link: null, note: "no active approved sound for this platform/date" };
  const base = { soundId: sound.id, bpm: sound.bpm, beatOffsetSec: sound.beatOffsetSec, beats: sound.beats, link: sound.link };
  if (!sound.approvedPlatforms.includes(platform))
    throw new AudioError(`${sound.id} is not approved for ${platform}`);
  const licensed = sound.license.status === "owned" || sound.license.status === "licensed";
  if (!licensed || !sound.license.embedAllowed)
    return { ...base, mode: "silent", file: null, note: `not embeddable (license: ${sound.license.status}); export silent, attach natively if wanted` };
  if (!sound.file) throw new AudioError(`${sound.id}: embedAllowed but no file configured`);
  const file = abs(sound.file);
  if (!existsSync(file)) {
    if (sound.generator?.type === "synth") {
      mkdirSync(dirname(file), { recursive: true });
      const g = sound.generator;
      writeFileSync(file, synthBeat({ bpm: sound.bpm, seconds: g.seconds, seed: g.seed, offsetSec: sound.beatOffsetSec }));
    } else throw new AudioError(`${sound.id}: audio file missing: ${sound.file}`);
  }
  return { ...base, mode: "embedded", file, note: `embedded (${sound.license.status}${sound.license.proof ? `, ${sound.license.proof}` : ""})` };
}
