import { type Canvas, createCanvas } from "@napi-rs/canvas";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Ctx, fitWrapped, font, ROOT, rrect } from "../engine/draw.ts";
import type { VideoSpec } from "./types.ts";

const AV = 512;
const images = new Map<string, Canvas | null>();
/** Decode an image file to a square canvas, synchronously (ffmpeg does the decoding). */
function image(rel: string): Canvas | null {
  if (!images.has(rel)) {
    const file = isAbsolute(rel) ? rel : join(ROOT, rel);
    let out: Canvas | null = null;
    if (existsSync(file)) {
      const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop='min(iw,ih)':'min(iw,ih)',scale=${AV}:${AV}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 26 });
      out = createCanvas(AV, AV);
      const octx = out.getContext("2d");
      const data = octx.createImageData(AV, AV);
      data.data.set(raw);
      octx.putImageData(data, 0, 0);
    }
    images.set(rel, out);
  }
  return images.get(rel)!;
}

/** Profile photo in a circle; falls back to the initial on a gradient. */
export function avatar(ctx: Ctx, cx: number, cy: number, r: number, spec: VideoSpec) {
  const img = spec.profile.avatarImage ? image(spec.profile.avatarImage) : null;
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
    return;
  }
  const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  g.addColorStop(0, spec.profile.avatar[0]);
  g.addColorStop(1, spec.profile.avatar[1]);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = font(800, r * 1.05);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(spec.profile.initial, cx, cy + r * 0.04);
  ctx.textBaseline = "alphabetic";
}

type Render = (ctx: Ctx, spec: VideoSpec, t: number) => void;
const thumbCache = new WeakMap<VideoSpec, Map<number, Canvas>>();
let scratch: Canvas | null = null;

/**
 * Small render of this same template as it looks at snapshot `snap`. Used for
 * the "previous posts" inside a video, so they look like the channel's own
 * uploads (as in the reference) instead of blank tiles. Cached per video.
 */
function thumbAt(spec: VideoSpec, render: Render, snap: number): Canvas {
  let cache = thumbCache.get(spec);
  if (!cache) thumbCache.set(spec, (cache = new Map()));
  let small = cache.get(snap);
  if (!small) {
    scratch ??= createCanvas(spec.width, spec.height);
    const fctx = scratch.getContext("2d");
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.globalAlpha = 1;
    render(fctx, { ...spec, noThumbs: true }, (spec.cuts[snap] + 0.5) / spec.fps);
    small = createCanvas(360, 640);
    small.getContext("2d").drawImage(scratch, 0, 0, 360, 640);
    cache.set(snap, small);
  }
  return small;
}

function drawThumb(ctx: Ctx, img: Canvas | null, x: number, y: number, w: number, h: number, radius: number) {
  ctx.save();
  rrect(ctx, x, y, w, h, radius);
  ctx.clip();
  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(x, y, w, h);
  if (img) {
    const scale = Math.max(w / img.width, h / img.height);
    const sw = w / scale;
    const sh = h / scale;
    // keep the top of the frame (name + count) in view
    ctx.drawImage(img, (img.width - sw) / 2, Math.min(img.height - sh, img.height * 0.08), sw, sh, x, y, w, h);
  }
  ctx.restore();
}

/** Thumbnail of the video exactly as it looks at snapshot `snap`; does not change during the video. */
export function fixedThumb(ctx: Ctx, spec: VideoSpec, render: Render, snap: number, x: number, y: number, w: number, h: number, radius: number) {
  drawThumb(ctx, spec.noThumbs ? null : thumbAt(spec, render, snap), x, y, w, h, radius);
}

/** First snapshot whose count has reached `fraction` of the video's final count. */
export function snapshotAtShare(spec: VideoSpec, fraction: number): number {
  const target = spec.endCount * fraction;
  const i = spec.snapshots.findIndex((s) => s.count >= target && s.count > 0);
  return i < 0 ? spec.snapshots.length - 1 : i;
}

/** Largest size (<= max) at which `s` fits in maxW; keeps very long counts on one line. */
export function fitSize(ctx: Ctx, s: string, weight: number, max: number, maxW: number): number {
  let size = max;
  for (; size > 24; size -= 2) {
    ctx.font = font(weight, size);
    if (ctx.measureText(s).width <= maxW) break;
  }
  return size;
}

/** Follower/subscriber share of each past post shown in a video, newest first. */
export const PAST_SHARES = [0.93, 0.62, 0.34, 0.12, 0.03, 0.003];

export function text(ctx: Ctx, s: string, x: number, y: number, weight: number, size: number, color: string, align: "left" | "center" | "right" = "left") {
  ctx.font = font(weight, size);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
}

/** Phone status bar of the "screenshot": clock, signal bars, battery. */
export function statusBar(ctx: Ctx, clock: string, y = 78) {
  text(ctx, clock, 92, y, 600, 34, "#fff");
  ctx.fillStyle = "#fff";
  for (let i = 0; i < 4; i++) ctx.fillRect(820 + i * 13, y - 6 - i * 6, 8, 8 + i * 6);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 3;
  rrect(ctx, 900, y - 27, 62, 30, 9);
  ctx.stroke();
  rrect(ctx, 904, y - 23, 54, 22, 6);
  ctx.fill();
}

/** Small circular status glyph: 1 = green up arrow, 0 = green check ring, -1 = grey down arrow. */
export function trendIcon(ctx: Ctx, cx: number, cy: number, trend: number, r = 15) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3.5;
  if (trend === 0) {
    ctx.strokeStyle = "#2ba640";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy);
    ctx.lineTo(cx - 1.5, cy + 5);
    ctx.lineTo(cx + 7, cy - 5);
    ctx.stroke();
  } else {
    ctx.fillStyle = trend > 0 ? "#2ba640" : "#8a8a8a";
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#0f0f0f";
    const d = trend > 0 ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7 * d);
    ctx.lineTo(cx, cy + 7 * d);
    ctx.moveTo(cx - 6, cy + 1 * d);
    ctx.lineTo(cx, cy + 7 * d);
    ctx.lineTo(cx + 6, cy + 1 * d);
    ctx.stroke();
  }
  ctx.restore();
}

/** Tiny stat glyphs for content rows. */
export function glyph(ctx: Ctx, kind: "views" | "likes" | "comments" | "shares", x: number, y: number, s: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = s * 0.11;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (kind === "views") {
    [0.45, 1, 0.7].forEach((h, i) => ctx.fillRect(x + i * s * 0.34, y - s * h, s * 0.2, s * h));
  } else if (kind === "likes") {
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.5);
    ctx.lineTo(x + s * 0.28, y - s * 0.5);
    ctx.lineTo(x + s * 0.5, y - s);
    ctx.lineTo(x + s * 0.62, y - s * 0.55);
    ctx.lineTo(x + s, y - s * 0.55);
    ctx.lineTo(x + s * 0.86, y);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.stroke();
  } else if (kind === "comments") {
    rrect(ctx, x, y - s * 0.95, s, s * 0.72, s * 0.14);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + s * 0.25, y - s * 0.23);
    ctx.lineTo(x + s * 0.25, y);
    ctx.lineTo(x + s * 0.5, y - s * 0.23);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.1);
    ctx.quadraticCurveTo(x + s * 0.1, y - s * 0.7, x + s * 0.6, y - s * 0.7);
    ctx.lineTo(x + s * 0.6, y - s);
    ctx.lineTo(x + s, y - s * 0.55);
    ctx.lineTo(x + s * 0.6, y - s * 0.1);
    ctx.lineTo(x + s * 0.6, y - s * 0.4);
    ctx.quadraticCurveTo(x + s * 0.25, y - s * 0.4, x, y - s * 0.1);
    ctx.stroke();
  }
  ctx.restore();
}

export function chevron(ctx: Ctx, cx: number, cy: number, dir: "up" | "down" | "right" | "left", color = "#aaa", s = 10) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.translate(cx, cy);
  ctx.rotate(dir === "down" ? 0 : dir === "up" ? Math.PI : dir === "left" ? Math.PI / 2 : -Math.PI / 2);
  ctx.beginPath();
  ctx.moveTo(-s, -s / 2);
  ctx.lineTo(0, s / 2);
  ctx.lineTo(s, -s / 2);
  ctx.stroke();
  ctx.restore();
}

/** Static two-line caption: white, heavy, black outline — as in the reference. */
export function outlinedCaption(ctx: Ctx, caption: string, cx: number, cy: number, maxW: number, maxSize: number) {
  const { size, lines } = fitWrapped(ctx, caption, 700, maxSize, maxW, 2);
  const lh = size * 1.22;
  ctx.font = font(700, size);
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  lines.forEach((ln, i) => {
    const y = cy - ((lines.length - 1) * lh) / 2 + i * lh + size * 0.35;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = size * 0.17;
    ctx.strokeText(ln, cx, y);
    ctx.fillStyle = "#fff";
    ctx.fillText(ln, cx, y);
  });
}

/** Small pill stating the numbers are simulated. Hidden when disclosure is null. */
export function disclosurePill(ctx: Ctx, spec: VideoSpec, right: number, y: number) {
  if (!spec.disclosure) return;
  ctx.font = font(500, 24);
  const w = ctx.measureText(spec.disclosure).width + 32;
  rrect(ctx, right - w, y - 28, w, 40, 20);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.textAlign = "center";
  ctx.fillText(spec.disclosure, right - w / 2, y);
}

export { rrect };
