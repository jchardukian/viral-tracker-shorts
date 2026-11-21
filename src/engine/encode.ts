import { createCanvas, loadImage } from "@napi-rs/canvas";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { templateFor } from "../spec.ts";
import { snapshotIndex, type VideoSpec } from "../templates/types.ts";
import { registerFonts } from "./draw.ts";

export function renderFrame(spec: VideoSpec, t: number) {
  registerFonts();
  const canvas = createCanvas(spec.width, spec.height);
  const ctx = canvas.getContext("2d");
  templateFor(spec).render(ctx, spec, t);
  return canvas;
}

export function renderStill(spec: VideoSpec, t: number, out: string) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderFrame(spec, t).toBuffer("image/png"));
}

/**
 * Render every frame and pipe raw RGBA into ffmpeg.
 * Output: 1080x1920 H.264 (yuv420p, faststart) + AAC. When the spec's audio is
 * "silent" a silent AAC track is still written, so every file has the same
 * stream layout and uploads cleanly.
 */
export async function renderVideo(spec: VideoSpec, out: string, opts: { forceSilent?: boolean } = {}) {
  registerFonts();
  mkdirSync(dirname(out), { recursive: true });
  const embed = spec.audio.mode === "embedded" && spec.audio.file && !opts.forceSilent;
  const args = [
    "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${spec.width}x${spec.height}`, "-r", String(spec.fps), "-i", "pipe:0",
    ...(embed
      ? ["-i", spec.audio.file as string]
      : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]),
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-level", "4.2", "-r", String(spec.fps),
    "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
    ...(embed ? ["-af", `afade=t=out:st=${Math.max(0, spec.durationSec - 0.25).toFixed(3)}:d=0.25`] : []),
    "-t", spec.durationSec.toFixed(4), "-movflags", "+faststart", out,
  ];
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "pipe"] });
  let err = "";
  ff.stderr.on("data", (d) => (err += d));
  const closed = once(ff, "close");
  const canvas = createCanvas(spec.width, spec.height);
  const ctx = canvas.getContext("2d");
  const tpl = templateFor(spec);
  let last = -1;
  for (let f = 0; f < spec.frames; f++) {
    const snap = snapshotIndex(spec, f);
    if (snap !== last) {
      // hard cuts only: redraw when the snapshot changes, otherwise resend the frame
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      tpl.render(ctx, spec, f / spec.fps);
      last = snap;
    }
    if (!ff.stdin.write(canvas.data())) await once(ff.stdin, "drain");
  }
  ff.stdin.end();
  const [code] = await closed;
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${err}`);
}

export interface Probe {
  width: number;
  height: number;
  vcodec: string;
  pixFmt: string;
  fps: number;
  acodec: string | null;
  durationSec: number;
  sizeBytes: number;
  /** mean volume in dB of the audio track (−91 ≈ digital silence) */
  meanVolumeDb: number | null;
}

export function probe(file: string): Probe {
  const j = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }),
  );
  const v = j.streams.find((s: any) => s.codec_type === "video");
  const a = j.streams.find((s: any) => s.codec_type === "audio");
  const [n, d] = String(v.avg_frame_rate).split("/").map(Number);
  let meanVolumeDb: number | null = null;
  if (a) {
    const r = spawnSyncText("ffmpeg", ["-hide_banner", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"]);
    const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r);
    meanVolumeDb = m ? (m[1] === "-inf" ? -Infinity : Number(m[1])) : null;
  }
  return {
    width: v.width,
    height: v.height,
    vcodec: v.codec_name,
    pixFmt: v.pix_fmt,
    fps: n / d,
    acodec: a?.codec_name ?? null,
    durationSec: Number(j.format.duration),
    sizeBytes: Number(j.format.size),
    meanVolumeDb,
  };
}

function spawnSyncText(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

export const fileSha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Side-by-side sheet of PNG stills, for quick visual review. */
export async function contactSheet(files: string[], out: string, cols: number, cellW = 360) {
  const imgs = await Promise.all(files.map((f) => loadImage(f)));
  const cellH = Math.round((cellW * imgs[0].height) / imgs[0].width);
  const rows = Math.ceil(imgs.length / cols);
  const gap = 12;
  const canvas = createCanvas(cols * cellW + (cols + 1) * gap, rows * cellH + (rows + 1) * gap);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  imgs.forEach((im, i) => {
    ctx.drawImage(im, gap + (i % cols) * (cellW + gap), gap + Math.floor(i / cols) * (cellH + gap), cellW, cellH);
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, canvas.toBuffer("image/png"));
}
