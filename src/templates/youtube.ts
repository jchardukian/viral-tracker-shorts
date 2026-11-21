import { type Ctx, wrap } from "../engine/draw.ts";
import { formatCount, shortCount, shortHours } from "../engine/util.ts";
import { avatar, chevron, disclosurePill, glyph, outlinedCaption, rrect, statusBar, text, trendIcon } from "./common.ts";
import { type ContentCard, frameOf, type Snapshot, snapshotIndex, type Template, type VideoSpec } from "./types.ts";

// A creator-dashboard screen in the style of the reference recording:
// header, channel + total subscribers, 28-day analytics cards, latest content
// with its detail rows, tab bar. Original mark and icons; no platform logos.

const BG = "#0f0f0f";
const CARD = "#1f1f1f";
const DIM = "#aaaaaa";
const L = 90; // content left edge
const R = 978; // content right edge
const W = R - L;

const layout = {
  profile: { x: L, y: 300, w: W, h: 200 },
  analytics: { x: L, y: 555, w: W, h: 270 },
  caption: { x: 100, y: 940, w: 800, h: 230 },
};

function contentHead(ctx: Ctx, c: ContentCard, y: number, open: boolean | null) {
  // thumbnail: a tiny dashboard screenshot, like the reference's own uploads
  rrect(ctx, L + 30, y + 26, 76, 116, 8);
  ctx.fillStyle = "#101010";
  ctx.fill();
  ctx.fillStyle = "#3d3d3d";
  [18, 34, 50, 66, 84].forEach((dy, i) => ctx.fillRect(L + 40, y + 26 + dy, i % 2 ? 40 : 56, 6));
  ctx.fillStyle = "#c33";
  ctx.fillRect(L + 40, y + 34, 14, 6);
  text(ctx, c.title, L + 150, y + 68, 500, 30, "#fff");
  text(ctx, c.age, L + 150, y + 112, 400, 27, DIM);
  const sy = y + 226;
  glyph(ctx, "views", L + 38, sy, 26, "#ddd");
  text(ctx, shortCount(c.views), L + 78, sy, 500, 28, "#ddd");
  glyph(ctx, "likes", L + 210, sy, 26, "#ddd");
  text(ctx, shortCount(c.likes), L + 250, sy, 500, 28, "#ddd");
  glyph(ctx, "comments", L + 370, sy, 26, "#ddd");
  text(ctx, formatCount(c.comments), L + 410, sy, 500, 28, "#ddd");
  if (open !== null) chevron(ctx, R - 44, sy - 10, open ? "up" : "down");
}

function row(ctx: Ctx, y: number, label: string, value: string, trend: number | null, link = false) {
  text(ctx, label, L + 38, y, 400, 29, "#e6e6e6");
  text(ctx, value, R - (trend === null && !link ? 44 : 96), y, 400, 29, "#e6e6e6", "right");
  if (trend !== null) trendIcon(ctx, R - 56, y - 10, trend);
  if (link) chevron(ctx, R - 52, y - 10, "right");
}

function latest(ctx: Ctx, s: Snapshot) {
  const y = 965;
  const c = s.latest;
  if (!c.expanded) {
    rrect(ctx, L, y, W, 270, 14);
    ctx.fillStyle = CARD;
    ctx.fill();
    contentHead(ctx, c, y, false);
    s.older.forEach((o, i) => {
      const oy = y + 300 + i * 300;
      rrect(ctx, L, oy, W, 270, 14);
      ctx.fillStyle = CARD;
      ctx.fill();
      contentHead(ctx, o, oy, false);
    });
    return;
  }
  rrect(ctx, L, y, W, 900, 14);
  ctx.fillStyle = CARD;
  ctx.fill();
  contentHead(ctx, c, y, true);
  let ry = y + 300;
  if (c.note) {
    rrect(ctx, L + 28, ry - 20, W - 56, 124, 12);
    ctx.fillStyle = "#3a3a3a";
    ctx.fill();
    ctx.font = `600 28px "VTS Inter"`;
    wrap(ctx, c.note, W - 130).slice(0, 2).forEach((ln, i) => text(ctx, ln, L + 58, ry + 32 + i * 38, 600, 28, "#fff"));
    ry += 150;
  }
  ry += 44;
  row(ctx, ry, "Ranking by views", `${c.rank} of 10`, null, true);
  row(ctx, ry + 88, "Views", shortCount(c.views), c.trend[0]);
  row(ctx, ry + 176, "Average percentage viewed", `${c.avgPct.toFixed(1)}%`, c.trend[1]);
  row(ctx, ry + 264, "Likes", shortCount(c.likes), c.trend[2]);
  row(ctx, ry + 352, "Comments", formatCount(c.comments), null);
}

function metric(ctx: Ctx, x: number, label: string, value: string, up: boolean) {
  rrect(ctx, x, 640, (W - 24) / 2, 180, 14);
  ctx.fillStyle = CARD;
  ctx.fill();
  text(ctx, label, x + 36, 702, 400, 27, DIM);
  text(ctx, value, x + 36, 770, 700, 42, "#fff");
  if (up) trendIcon(ctx, x + 36 + ctx.measureText(value).width + 28, 756, 1, 14);
}

function tabBar(ctx: Ctx) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 1790, 1080, 130);
  ["Dashboard", "Content", "Analytics", "Community", "Earn"].forEach((name, i) => {
    const cx = 150 + i * 195;
    const col = i === 0 ? "#fff" : "#9a9a9a";
    ctx.strokeStyle = col;
    ctx.lineWidth = 4;
    rrect(ctx, cx - 20, 1812, 40, 36, 8);
    ctx.stroke();
    text(ctx, name, cx, 1888, 500, 23, col, "center");
  });
}

function render(ctx: Ctx, spec: VideoSpec, t: number) {
  const s = spec.snapshots[snapshotIndex(spec, frameOf(spec, t))];
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, spec.width, spec.height);
  statusBar(ctx, s.clock);

  // header: original bar-chart mark + wordmark, action icons
  rrect(ctx, L, 172, 56, 42, 11);
  ctx.fillStyle = "#e5322d";
  ctx.fill();
  ctx.fillStyle = "#fff";
  [14, 24, 18].forEach((h, i) => ctx.fillRect(L + 14 + i * 11, 172 + 33 - h, 7, h));
  text(ctx, "Studio", L + 70, 208, 600, 40, "#fff");
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(778, 194, 20, 0, Math.PI * 2);
  ctx.moveTo(768, 194);
  ctx.lineTo(788, 194);
  ctx.moveTo(778, 184);
  ctx.lineTo(778, 204);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(866, 196, 17, Math.PI, 0);
  ctx.lineTo(886, 212);
  ctx.lineTo(846, 212);
  ctx.closePath();
  ctx.stroke();
  avatar(ctx, 950, 194, 22, spec);

  // channel + total subscribers
  avatar(ctx, L + 92, 400, 92, spec);
  text(ctx, spec.profile.name, L + 226, 352, 600, 40, "#fff");
  text(ctx, formatCount(s.count), L + 226, 426, 700, 58, "#fff");
  text(ctx, "Total subscribers", L + 226, 480, 400, 30, DIM);
  disclosurePill(ctx, spec, R, 480);

  // channel analytics, last 28 days
  text(ctx, "Channel analytics", L, 598, 700, 42, "#fff");
  text(ctx, "Last 28 days", R, 596, 400, 26, DIM, "right");
  metric(ctx, L, "Views", shortCount(s.views28), s.up);
  metric(ctx, L + (W + 24) / 2, "Watch time (hours)", shortHours(s.watch28), s.up);

  text(ctx, "Latest published content", L, 928, 700, 42, "#fff");
  latest(ctx, s);
  tabBar(ctx);

  // static caption over the content card, exactly where the reference keeps it
  const c = layout.caption;
  outlinedCaption(ctx, spec.caption, 540, c.y + c.h / 2, c.w, 80);
}

export const youtubeTemplate: Template = {
  platform: "youtube",
  // Shorts player chrome: top bar, bottom title/channel block, right action rail.
  safe: { top: 240, bottom: 1480, left: 48, right: 1032, rail: { x: 920, y0: 1180, y1: 1920 } },
  layout,
  render,
};
