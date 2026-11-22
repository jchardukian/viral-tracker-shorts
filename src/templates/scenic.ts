import { type Ctx, fitWrapped, font } from "../engine/draw.ts";
import { rrect } from "./common.ts";
import type { Platform, Template, VideoSpec } from "./types.ts";

// Scenic variant: real footage (free-licence stock clips, see config/footage.json)
// with one static header on top, in the white-label style common to this format.
// The template only draws the header; the footage is composited by ffmpeg.

const layout = {
  caption: { x: 100, y: 320, w: 880, h: 190 },
};

function render(ctx: Ctx, spec: VideoSpec, _t: number) {
  ctx.clearRect(0, 0, spec.width, spec.height);
  const c = layout.caption;
  const { size, lines } = fitWrapped(ctx, spec.caption, 800, 60, c.w - 60, 2);
  const lh = size * 1.32;
  ctx.font = font(800, size);
  ctx.textAlign = "center";
  lines.forEach((ln, k) => {
    const w = ctx.measureText(ln).width + 52;
    rrect(ctx, 540 - w / 2, c.y + 10 + k * lh, w, lh + 2, 14);
    ctx.fillStyle = "#fff";
    ctx.fill();
  });
  lines.forEach((ln, k) => {
    ctx.fillStyle = "#111";
    ctx.fillText(ln, 540, c.y + 10 + k * lh + size * 0.99);
  });
}

export const scenicTemplate = (platform: Platform): Template => ({
  platform,
  safe: platform === "youtube" ? { top: 240, bottom: 1480, left: 48, right: 1032, rail: { x: 920, y0: 1180, y1: 1920 } } : { top: 200, bottom: 1450, left: 48, right: 1032, rail: { x: 930, y0: 900, y1: 1920 } },
  layout,
  render,
  footage: true,
});
