import { type Ctx, fitWrapped, font } from "../engine/draw.ts";
import { formatCount, shortCount } from "../engine/util.ts";
import { avatar, chevron, disclosurePill, glyph, postThumb, rrect, statusBar, text } from "./common.ts";
import { frameOf, snapshotIndex, type Template, type VideoSpec } from "./types.ts";

// The same time-lapse, as a follower-analytics screen: tabs, total followers
// with a 7-day delta, key metrics, a follower growth chart that draws itself
// as the days cut past, and the most recent post.

const CYAN = "#25f4ee";
const CARD = "#161616";
const DIM = "#8a8a8a";
const L = 60;
const R = 1020;
const RR = 900; // right edge below the action rail

const layout = {
  followers: { x: L, y: 480, w: 840, h: 240 },
  metrics: { x: L, y: 745, w: 840, h: 150 },
  chart: { x: L, y: 915, w: 840, h: 270 },
  caption: { x: 100, y: 1230, w: 780, h: 200 },
};

function render(ctx: Ctx, spec: VideoSpec, t: number) {
  const i = snapshotIndex(spec, frameOf(spec, t));
  const s = spec.snapshots[i];
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, spec.width, spec.height);
  statusBar(ctx, s.clock);

  // header + tabs
  chevron(ctx, 84, 196, "left", "#fff", 13);
  text(ctx, "Analytics", 540, 212, 700, 44, "#fff", "center");
  const tabs = ["Overview", "Content", "Followers", "LIVE"];
  tabs.forEach((name, k) => {
    const x = 150 + k * 260;
    text(ctx, name, x, 306, k === 2 ? 700 : 500, 34, k === 2 ? "#fff" : DIM, "center");
    if (k === 2) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - 60, 324, 120, 5);
    }
  });
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 330, 1080, 2);

  // profile row
  avatar(ctx, L + 46, 410, 46, spec);
  text(ctx, spec.profile.handle, L + 116, 404, 600, 36, "#fff");
  text(ctx, `Last 7 days · ${s.date}`, L + 116, 446, 400, 27, DIM);
  disclosurePill(ctx, spec, R, 416);

  // total followers
  text(ctx, "Total followers", L, 536, 500, 34, DIM);
  text(ctx, formatCount(s.count), L, 652, 800, 116, "#fff");
  const pct = s.count - s.delta7 > 0 ? (s.delta7 / (s.count - s.delta7)) * 100 : 0;
  text(ctx, `+${formatCount(s.delta7)} (${pct >= 1000 ? "999+" : pct.toFixed(1)}%)`, L, 708, 600, 32, CYAN);
  text(ctx, "vs previous 7 days", L + ctx.measureText(`+${formatCount(s.delta7)} (${pct >= 1000 ? "999+" : pct.toFixed(1)}%)`).width + 16, 708, 400, 30, DIM);

  // key metrics
  const m = layout.metrics;
  const cells: [string, string][] = [
    ["Video views", shortCount(s.views28)],
    ["Profile views", shortCount(s.profileViews)],
    ["Likes", shortCount(s.likesTotal)],
  ];
  const cw = (R - L - 32) / 3;
  cells.forEach(([label, value], k) => {
    const x = L + k * (cw + 16);
    rrect(ctx, x, m.y, cw, m.h, 18);
    ctx.fillStyle = CARD;
    ctx.fill();
    text(ctx, label, x + 26, m.y + 52, 500, 27, DIM);
    text(ctx, value, x + 26, m.y + 112, 700, 44, "#fff");
  });

  // follower growth chart: the line extends as the time-lapse advances
  const c = layout.chart;
  rrect(ctx, L, c.y, RR - L, c.h, 18);
  ctx.fillStyle = CARD;
  ctx.fill();
  text(ctx, "Follower growth", L + 26, c.y + 50, 600, 30, "#fff");
  const px = L + 30;
  const pw = RR - L - 60;
  const py = c.y + 80;
  const ph = c.h - 132;
  ctx.strokeStyle = "#262626";
  ctx.lineWidth = 2;
  for (let g = 0; g <= 2; g++) {
    ctx.beginPath();
    ctx.moveTo(px, py + (ph * g) / 2);
    ctx.lineTo(px + pw, py + (ph * g) / 2);
    ctx.stroke();
  }
  const max = Math.max(1, spec.endCount);
  const n = spec.snapshots.length - 1;
  const X = (k: number) => px + (pw * k) / n;
  const Y = (v: number) => py + ph - (ph * v) / max;
  ctx.beginPath();
  ctx.moveTo(X(0), Y(spec.snapshots[0].count));
  for (let k = 1; k <= i; k++) ctx.lineTo(X(k), Y(spec.snapshots[k].count));
  ctx.strokeStyle = CYAN;
  ctx.lineWidth = 6;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.lineTo(X(i), py + ph);
  ctx.lineTo(X(0), py + ph);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, py, 0, py + ph);
  fill.addColorStop(0, "rgba(37,244,238,0.35)");
  fill.addColorStop(1, "rgba(37,244,238,0)");
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(X(i), Y(s.count), 10, 0, Math.PI * 2);
  ctx.fill();
  text(ctx, spec.snapshots[0].date, px, c.y + c.h - 14, 400, 22, DIM);
  text(ctx, spec.snapshots[n].date, px + pw, c.y + c.h - 14, 400, 22, DIM, "right");

  // most recent post
  const y = 1210;
  rrect(ctx, L, y, RR - L, 250, 18);
  ctx.fillStyle = CARD;
  ctx.fill();
  text(ctx, "Most recent post", L + 26, y + 52, 600, 30, "#fff");
  postThumb(ctx, spec, render, i, 0, L + 26, y + 80, 96, 140, 10);
  text(ctx, s.latest.title, L + 150, y + 122, 500, 30, "#fff");
  text(ctx, s.latest.age, L + 150, y + 162, 400, 26, DIM);
  const stats: ["views" | "likes" | "comments" | "shares", number][] = [
    ["views", s.latest.views],
    ["likes", s.latest.likes],
    ["comments", s.latest.comments],
    ["shares", s.shares],
  ];
  stats.forEach(([k, v], j) => {
    glyph(ctx, k, L + 150 + j * 172, y + 216, 24, "#ddd");
    text(ctx, shortCount(v), L + 186 + j * 172, y + 216, 500, 27, "#ddd");
  });

  // earlier posts (sits under the player's own caption area)
  rrect(ctx, L, 1485, RR - L, 330, 18);
  ctx.fillStyle = CARD;
  ctx.fill();
  text(ctx, "Earlier posts", L + 26, 1537, 600, 30, "#fff");
  s.older.forEach((o, j) => {
    const oy = 1570 + j * 118;
    postThumb(ctx, spec, render, i, j + 1, L + 26, oy, 66, 96, 8);
    text(ctx, o.title, L + 116, oy + 38, 500, 28, "#fff");
    glyph(ctx, "views", L + 116, oy + 84, 22, "#bbb");
    text(ctx, shortCount(o.views), L + 150, oy + 84, 500, 25, "#bbb");
    glyph(ctx, "likes", L + 290, oy + 84, 22, "#bbb");
    text(ctx, shortCount(o.likes), L + 324, oy + 84, 500, 25, "#bbb");
  });

  // static caption: label-style text blocks
  const cap = layout.caption;
  const { size, lines } = fitWrapped(ctx, spec.caption, 800, 58, cap.w - 60, 2);
  const lh = size * 1.3;
  const cy = cap.y + cap.h / 2;
  ctx.font = font(800, size);
  ctx.textAlign = "center";
  lines.forEach((ln, k) => {
    const ly = cy - (lines.length * lh) / 2 + k * lh;
    const w = ctx.measureText(ln).width + 48;
    rrect(ctx, 540 - w / 2, ly, w, lh + 2, 16);
    ctx.fillStyle = "#fff";
    ctx.fill();
  });
  lines.forEach((ln, k) => {
    ctx.fillStyle = "#111";
    ctx.fillText(ln, 540, cy - (lines.length * lh) / 2 + k * lh + size * 0.98);
  });
}

export const tiktokTemplate: Template = {
  platform: "tiktok",
  // For-You chrome: top tabs, bottom username/caption/sound block, right rail.
  safe: { top: 200, bottom: 1450, left: 48, right: 1032, rail: { x: 930, y0: 900, y1: 1920 } },
  layout,
  render,
};
