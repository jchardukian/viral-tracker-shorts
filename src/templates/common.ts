import { type Ctx, font, type Rect, rrect } from "../engine/draw.ts";
import { clamp, easeOutBack, easeOutCubic, formatCount, prog } from "../engine/util.ts";
import type { VideoSpec } from "./types.ts";

/** Slide-down + fade entrance for a block. Returns false while fully hidden. */
export function enter(ctx: Ctx, t: number, delay: number, fn: () => void, dy = 40) {
  const p = prog(t, delay, 0.5);
  if (p <= 0) return;
  ctx.save();
  ctx.globalAlpha *= easeOutCubic(p);
  ctx.translate(0, (1 - easeOutBack(p)) * -dy);
  fn();
  ctx.restore();
}

export function glow(ctx: Ctx, x: number, y: number, r: number, color: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}

export function avatar(ctx: Ctx, cx: number, cy: number, r: number, spec: VideoSpec) {
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

/** "+N" chips that float up from (x, y) after each counter step. */
export function floatChips(ctx: Ctx, spec: VideoSpec, t: number, x: number, y: number, color: string, size = 44) {
  for (const s of spec.steps) {
    const p = (t - s.t) / 0.85;
    if (p < 0 || p > 1) continue;
    ctx.save();
    ctx.globalAlpha *= clamp(p * 6) * (1 - Math.pow(p, 3));
    ctx.font = font(800, size);
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.fillText(`+${formatCount(s.to - s.from)}`, x, y - easeOutCubic(p) * 70);
    ctx.restore();
  }
}

/** Touch indicator that glides to the CTA, taps, and leaves a ripple. */
export function tapPointer(ctx: Ctx, spec: VideoSpec, t: number, btn: Rect) {
  const tx = btn.x + btn.w * 0.66;
  const ty = btn.y + btn.h * 0.6;
  const approach = prog(t, spec.tapAt - 0.55, 0.5);
  const leave = prog(t, spec.tapAt + 0.25, 0.4);
  if (approach > 0 && leave < 1) {
    const e = easeOutCubic(approach);
    const x = tx + (1 - e) * 150;
    const y = ty + (1 - e) * 210;
    const press = 1 - 0.22 * (1 - Math.abs(clamp((t - spec.tapAt) / 0.12, -1, 1)));
    ctx.save();
    ctx.globalAlpha *= clamp(approach * 4) * (1 - leave);
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(x, y, 38 * press, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  const rp = prog(t, spec.tapAt, 0.55);
  if (rp > 0 && rp < 1) {
    ctx.save();
    ctx.globalAlpha *= 1 - rp;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 8 * (1 - rp) + 1;
    ctx.beginPath();
    ctx.arc(tx, ty, 40 + easeOutCubic(rp) * 190, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** Scale applied to the CTA button: beat pulse before the tap, squish on tap. */
export function ctaScale(spec: VideoSpec, t: number, pulse: number): number {
  const dt = t - spec.tapAt;
  if (dt < 0) return 1 + 0.035 * pulse;
  if (dt < 0.12) return 1 - 0.07 * (dt / 0.12);
  return 0.93 + 0.07 * easeOutBack(clamp((dt - 0.12) / 0.3));
}

export function disclosure(ctx: Ctx, spec: VideoSpec, r: Rect) {
  if (!spec.disclosure) return;
  ctx.font = font(500, 26);
  ctx.fillStyle = "rgba(255,255,255,0.42)";
  ctx.textAlign = "center";
  ctx.fillText(spec.disclosure, r.x + r.w / 2, r.y + r.h - 8);
}

export function checkIcon(ctx: Ctx, x: number, y: number, s: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.16;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x - s * 0.45, y);
  ctx.lineTo(x - s * 0.12, y + s * 0.33);
  ctx.lineTo(x + s * 0.48, y - s * 0.36);
  ctx.stroke();
  ctx.restore();
}

export { rrect };
