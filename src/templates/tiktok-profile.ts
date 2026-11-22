import { type Ctx, fitWrapped, font } from "../engine/draw.ts";
import { formatCount, shortCount } from "../engine/util.ts";
import { avatar, chevron, disclosurePill, fixedThumb, glyph, rrect, snapshotAtShare, statusBar, text } from "./common.ts";
import { frameOf, snapshotIndex, type Template, type VideoSpec } from "./types.ts";

// Simplified TikTok variant: a profile screen where the name and the follower
// count carry the whole video. Same hard-cut time-lapse, far fewer elements.

const DIM = "#8a8a8a";
/** follower count of each past post as a share of the video's final count */
const PAST_SHARES = [0.93, 0.62, 0.34, 0.12, 0.03, 0.003];

const layout = {
  name: { x: 190, y: 205, w: 700, h: 80 },
  followers: { x: 120, y: 640, w: 780, h: 250 },
  caption: { x: 160, y: 1215, w: 760, h: 200 },
};

function render(ctx: Ctx, spec: VideoSpec, t: number) {
  const s = spec.snapshots[snapshotIndex(spec, frameOf(spec, t))];
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, spec.width, spec.height);
  statusBar(ctx, s.clock);

  // profile name
  chevron(ctx, 84, 244, "left", "#fff", 13);
  text(ctx, spec.profile.name, 540, 264, 800, 56, "#fff", "center");
  ctx.fillStyle = "#fff";
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.arc(960 + k * 18, 246, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  avatar(ctx, 540, 440, 118, spec);
  text(ctx, spec.profile.handle, 540, 618, 600, 38, "#fff", "center");

  // follower count: the hero
  text(ctx, formatCount(s.count), 540, 790, 800, 156, "#fff", "center");
  text(ctx, "Followers", 540, 850, 500, 38, "#d6d6d6", "center");
  text(ctx, `48 Following   ·   ${shortCount(Math.round(s.count * 4.4))} Likes`, 540, 908, 500, 30, DIM, "center");

  // follow row
  rrect(ctx, 250, 950, 440, 96, 16);
  ctx.fillStyle = "#fe2c55";
  ctx.fill();
  text(ctx, "Follow", 470, 1014, 700, 42, "#fff", "center");
  rrect(ctx, 708, 950, 122, 96, 16);
  ctx.fillStyle = "#2a2a2a";
  ctx.fill();
  chevron(ctx, 769, 998, "down", "#fff", 13);
  disclosurePill(ctx, spec, 540 + 118, 1104);

  // posts grid: six past uploads, newest top-left, oldest bottom-right.
  // They are finished posts, so they stay fixed while the big number runs.
  PAST_SHARES.forEach((share, k) => {
    const past = snapshotAtShare(spec, share);
    const x = 28 + (k % 3) * 344;
    const y = 1140 + Math.floor(k / 3) * 392;
    fixedThumb(ctx, spec, render, past, x, y, 336, 384, 6);
    // darken the foot of the tile so the view count stays readable
    const g = ctx.createLinearGradient(0, y + 290, 0, y + 384);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.75)");
    ctx.fillStyle = g;
    ctx.fillRect(x, y + 290, 336, 94);
    glyph(ctx, "views", x + 18, y + 362, 22, "#fff");
    text(ctx, shortCount(spec.snapshots[past].latest.views), x + 50, y + 362, 600, 26, "#fff");
  });

  // static caption: label-style text blocks
  const cap = layout.caption;
  const { size, lines } = fitWrapped(ctx, spec.caption, 800, 58, cap.w - 60, 2);
  const lh = size * 1.3;
  const cy = cap.y + cap.h / 2;
  ctx.font = font(800, size);
  ctx.textAlign = "center";
  lines.forEach((ln, k) => {
    const w = ctx.measureText(ln).width + 48;
    rrect(ctx, 540 - w / 2, cy - (lines.length * lh) / 2 + k * lh, w, lh + 2, 16);
    ctx.fillStyle = "#fff";
    ctx.fill();
  });
  lines.forEach((ln, k) => {
    ctx.fillStyle = "#111";
    ctx.fillText(ln, 540, cy - (lines.length * lh) / 2 + k * lh + size * 0.98);
  });
}

export const tiktokProfileTemplate: Template = {
  platform: "tiktok",
  safe: { top: 200, bottom: 1450, left: 48, right: 1032, rail: { x: 930, y0: 900, y1: 1920 } },
  layout,
  render,
};
