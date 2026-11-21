import { type Ctx, drawOdometer, fitWrapped, font, odometerWidth, withTransform } from "../engine/draw.ts";
import { clamp, easeOutBack, formatCount, prog, shortCount } from "../engine/util.ts";
import { avatar, checkIcon, ctaScale, disclosure, enter, floatChips, glow, rrect, tapPointer } from "./common.ts";
import { beatPulse, captionAt, countAt, type Template, trackerFill, type VideoSpec } from "./types.ts";

const THEMES: Record<string, { panel: [string, string]; bar: [string, string]; glow: string; tip: string }> = {
  // deep red panel + green bar: the classic tracker look
  crimson: { panel: ["#8a0d0d", "#190303"], bar: ["#19e23a", "#5dff5a"], glow: "#ff2a2a", tip: "#ff5a3c" },
  midnight: { panel: ["#3a1020", "#0d0509"], bar: ["#ff2e2e", "#ff7a59"], glow: "#ff3355", tip: "#ffffff" },
  ember: { panel: ["#7a2a05", "#170802"], bar: ["#ffd21f", "#fff27a"], glow: "#ff6a1a", tip: "#ffffff" },
};

const layout = {
  profile: { x: 60, y: 250, w: 960, h: 270 },
  tracker: { x: 60, y: 560, w: 960, h: 440 },
  caption: { x: 160, y: 1040, w: 740, h: 230 },
  cta: { x: 270, y: 1300, w: 540, h: 124 },
  disclosure: { x: 240, y: 1436, w: 600, h: 40 },
};

function render(ctx: Ctx, spec: VideoSpec, t: number) {
  const th = THEMES[spec.theme] ?? THEMES.crimson;
  const count = countAt(spec, t);
  const pulse = beatPulse(spec, t);
  const L = layout;

  // background
  ctx.fillStyle = "#0f0f0f";
  ctx.fillRect(0, 0, spec.width, spec.height);
  glow(ctx, 540 + Math.sin(t * 0.7) * 60, 760, 900, th.glow, 0.1 + 0.03 * pulse);

  // --- profile: channel name + subscriber count together -------------------
  enter(ctx, t, 0, () => {
    const p = L.profile;
    rrect(ctx, p.x, p.y, p.w, p.h, 44);
    ctx.fillStyle = "#1a1a1a";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 2;
    ctx.stroke();
    avatar(ctx, p.x + 130, p.y + p.h / 2, 90, spec);
    const tx = p.x + 252;
    ctx.textAlign = "left";
    ctx.fillStyle = "#fff";
    ctx.font = font(600, 44);
    ctx.fillText(spec.profile.name, tx, p.y + 78);
    const w = odometerWidth(ctx, count, 104, 800);
    withTransform(ctx, tx, p.y + 180, 1 + 0.025 * pulse, 1, () =>
      drawOdometer(ctx, count, tx, p.y + 184, 104, 800, "#fff"),
    );
    ctx.font = font(500, 34);
    ctx.fillStyle = "#aaa";
    ctx.fillText("subscribers", tx, p.y + 236);
    floatChips(ctx, spec, t, Math.min(tx + w + 22, p.x + p.w - 190), p.y + 150, th.bar[1]);
  });

  // --- tracker --------------------------------------------------------------
  enter(ctx, t, 0.12, () => {
    const p = L.tracker;
    const g = ctx.createRadialGradient(p.x + p.w / 2, p.y + p.h * 0.45, 40, p.x + p.w / 2, p.y + p.h / 2, p.w * 0.62);
    g.addColorStop(0, th.panel[0]);
    g.addColorStop(1, th.panel[1]);
    rrect(ctx, p.x, p.y, p.w, p.h, 44);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.font = font(800, 36);
    ctx.fillText(`ROAD TO ${shortCount(spec.goal).toUpperCase()}`, p.x + 52, p.y + 86);
    const fill = trackerFill(spec, t);
    const pct = ((spec.trackFrom + fill * (spec.goal - spec.trackFrom)) / spec.goal) * 100;
    ctx.textAlign = "right";
    ctx.fillStyle = "#fff";
    ctx.font = font(900, 68);
    ctx.fillText(`${pct.toFixed(1)}%`, p.x + p.w - 52, p.y + 98);

    const bx = p.x + 76;
    const bw = p.w - 152;
    const by = p.y + 196;
    const bh = 40;
    rrect(ctx, bx - 8, by - 8, bw + 16, bh + 16, 30);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fill();
    const fw = Math.max(bh, bw * fill);
    const bg = ctx.createLinearGradient(bx, 0, bx + fw, 0);
    bg.addColorStop(0, th.bar[0]);
    bg.addColorStop(1, th.bar[1]);
    ctx.save();
    ctx.shadowColor = th.bar[0];
    ctx.shadowBlur = 34 + 30 * pulse;
    rrect(ctx, bx, by, fw, bh, bh / 2);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.restore();
    // tip
    ctx.save();
    ctx.shadowColor = th.tip;
    ctx.shadowBlur = 30;
    ctx.fillStyle = th.tip;
    ctx.beginPath();
    ctx.arc(bx + fw - bh / 2, by + bh / 2, 15 + 9 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // ticks + labels
    ctx.textAlign = "center";
    for (let i = 0; i <= 4; i++) {
      const x = bx + (bw * i) / 4;
      const v = spec.trackFrom + ((spec.goal - spec.trackFrom) * i) / 4;
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - 3, by + bh + 20, 6, 26);
      ctx.font = font(700, 38);
      ctx.fillText(shortCount(v).toLowerCase(), x, by + bh + 96);
    }
    ctx.font = font(600, 38);
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.fillText(`${formatCount(Math.max(0, spec.goal - Math.floor(count)))} to go`, p.x + 52, p.y + p.h - 40);
    ctx.textAlign = "right";
    ctx.fillText(`goal ${formatCount(spec.goal)}`, p.x + p.w - 52, p.y + p.h - 40);
  });

  // --- caption ---------------------------------------------------------------
  const cap = captionAt(spec, t);
  if (cap) {
    const c = L.caption;
    const { size, lines } = fitWrapped(ctx, cap.text, 900, 78, c.w - 20, 2);
    const p = prog(t, cap.t0, 0.28);
    const out = 1 - prog(t, cap.t1 - 0.12, 0.12);
    const lh = size * 1.16;
    const cy = c.y + c.h / 2;
    withTransform(ctx, c.x + c.w / 2, cy, 0.78 + 0.22 * easeOutBack(p), clamp(p * 3) * out, () => {
      ctx.font = font(900, size);
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      lines.forEach((ln, i) => {
        const y = cy - ((lines.length - 1) * lh) / 2 + i * lh + size * 0.35;
        ctx.strokeStyle = "#000";
        ctx.lineWidth = size * 0.15;
        ctx.strokeText(ln, c.x + c.w / 2, y);
        ctx.fillStyle = "#fff";
        ctx.fillText(ln, c.x + c.w / 2, y);
      });
    });
  }

  // --- subscribe CTA -----------------------------------------------------------
  enter(ctx, t, 0.3, () => {
    const b = L.cta;
    const done = t >= spec.tapAt + 0.12;
    withTransform(ctx, b.x + b.w / 2, b.y + b.h / 2, ctaScale(spec, t, pulse), 1, () => {
      rrect(ctx, b.x, b.y, b.w, b.h, b.h / 2);
      ctx.fillStyle = done ? "#2b2b2b" : "#fff";
      ctx.fill();
      ctx.font = font(700, 52);
      ctx.textAlign = "center";
      ctx.fillStyle = done ? "#fff" : "#0f0f0f";
      if (done) {
        checkIcon(ctx, b.x + 118, b.y + b.h / 2, 44, "#fff");
        ctx.fillText("Subscribed", b.x + b.w / 2 + 30, b.y + b.h / 2 + 18);
      } else ctx.fillText("Subscribe", b.x + b.w / 2, b.y + b.h / 2 + 18);
    });
  }, 0);
  tapPointer(ctx, spec, t, L.cta);
  disclosure(ctx, spec, L.disclosure);
}

export const youtubeTemplate: Template = {
  platform: "youtube",
  // Shorts player chrome: top bar, bottom title/channel block, right action rail.
  safe: { top: 240, bottom: 1480, left: 48, right: 1032, rail: { x: 920, y0: 1020, y1: 1920 } },
  layout,
  themes: Object.keys(THEMES),
  render,
};
