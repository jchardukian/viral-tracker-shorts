import { GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Ctx = SKRSContext2D;
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FONT = "VTS Inter";

let fontsReady = false;
/** Registers the bundled Inter weights under a private family name so renders
 * are identical on any machine, regardless of installed system fonts. */
export function registerFonts() {
  if (fontsReady) return;
  const dir = join(ROOT, "assets", "fonts");
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".otf")) GlobalFonts.registerFromPath(join(dir, f), FONT);
  }
  fontsReady = true;
}

export const font = (weight: number, size: number) => `${weight} ${size}px "${FONT}"`;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Greedy word wrap for the current ctx.font. */
export function wrap(ctx: Ctx, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(next).width > maxW) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Re-split a two-line wrap so both lines are close in width (no orphan words). */
function balance(ctx: Ctx, lines: string[]): string[] {
  if (lines.length !== 2) return lines;
  const words = lines.join(" ").split(" ");
  let best = lines;
  let bestW = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
    if (w < bestW) [best, bestW] = [[a, b], w];
  }
  return best;
}

/** Largest font size (<= max) at which `text` wraps into at most `maxLines`. */
export function fitWrapped(
  ctx: Ctx,
  text: string,
  weight: number,
  max: number,
  maxW: number,
  maxLines: number,
): { size: number; lines: string[] } {
  for (let size = max; size > 24; size -= 2) {
    ctx.font = font(weight, size);
    const lines = balance(ctx, wrap(ctx, text, maxW));
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW))
      return { size, lines };
  }
  ctx.font = font(weight, 24);
  return { size: 24, lines: wrap(ctx, text, maxW) };
}

/** Run `fn` scaled around (cx, cy) with global alpha multiplied. */
export function withTransform(
  ctx: Ctx,
  cx: number,
  cy: number,
  scale: number,
  alpha: number,
  fn: () => void,
) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  fn();
  ctx.restore();
}

/**
 * Odometer-style counter. `value` may be fractional mid-roll; every digit
 * column scrolls vertically like a mechanical counter. Returns drawn width.
 * (x, y) is the left edge / alphabetic baseline.
 */
export function drawOdometer(
  ctx: Ctx,
  value: number,
  x: number,
  y: number,
  size: number,
  weight: number,
  color: string,
  align: "left" | "center" = "left",
): number {
  ctx.save();
  ctx.font = font(weight, size);
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "center";
  const dw = Math.max(...[..."0123456789"].map((d) => ctx.measureText(d).width));
  const cw = ctx.measureText(",").width;
  const nDigits = Math.max(1, Math.floor(Math.max(value, 1)).toString().length);
  const total = nDigits * dw + Math.floor((nDigits - 1) / 3) * cw;
  let cx = align === "center" ? x - total / 2 : x;
  const lineH = size * 1.08;
  for (let i = nDigits - 1; i >= 0; i--) {
    const p = Math.pow(10, i);
    const base = Math.floor(value / p) % 10;
    // A column only rolls while every lower column is passing 9 -> 0.
    const lowerFrac = i === 0 ? value % 1 : (value % p) / p;
    const window = i === 0 ? 1 : 1 / p;
    const roll = i === 0 ? lowerFrac : lowerFrac > 1 - window ? (lowerFrac - (1 - window)) / window : 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - 2, y - size * 0.86, dw + 4, size * 1.06);
    ctx.clip();
    ctx.fillText(String(base), cx + dw / 2, y - roll * lineH);
    if (roll > 0.001) ctx.fillText(String((base + 1) % 10), cx + dw / 2, y + (1 - roll) * lineH);
    ctx.restore();
    cx += dw;
    if (i > 0 && i % 3 === 0) {
      ctx.fillText(",", cx + cw / 2, y);
      cx += cw;
    }
  }
  ctx.restore();
  return total;
}

export function odometerWidth(ctx: Ctx, value: number, size: number, weight: number): number {
  ctx.save();
  ctx.font = font(weight, size);
  const dw = Math.max(...[..."0123456789"].map((d) => ctx.measureText(d).width));
  const cw = ctx.measureText(",").width;
  const n = Math.max(1, Math.floor(Math.max(value, 1)).toString().length);
  ctx.restore();
  return n * dw + Math.floor((n - 1) / 3) * cw;
}
