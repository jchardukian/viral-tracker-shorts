import { type Ctx, drawOdometer, fitWrapped, font, withTransform } from "../engine/draw.ts";
import { clamp, easeOutBack, formatCount, prog, shortCount } from "../engine/util.ts";
import { avatar, checkIcon, ctaScale, disclosure, enter, floatChips, glow, rrect, tapPointer } from "./common.ts";
import { beatPulse, captionAt, countAt, type Template, trackerFill, type VideoSpec } from "./types.ts";

const THEMES: Record<string, { a: string; b: string; cta: string }> = {
  neon: { a: "#25f4ee", b: "#fe2c55", cta: "#fe2c55" },
  blush: { a: "#ff8fb1", b: "#fe2c55", cta: "#fe2c55" },
  aqua: { a: "#25f4ee", b: "#7b6bff", cta: "#fe2c55" },
};

const layout = {
  header: { x: 240, y: 212, w: 600, h: 72 },
  avatar: { x: 380, y: 305, w: 320, h: 320 },
  handle: { x: 240, y: 636, w: 600, h: 60 },
  stats: { x: 80, y: 716, w: 920, h: 170 },
  cta: { x: 230, y: 918, w: 480, h: 110 },
  ctaAlt: { x: 730, y: 918, w: 120, h: 110 },
  tracker: { x: 80, y: 1068, w: 840, h: 190 },
  caption: { x: 120, y: 1268, w: 780, h: 130 },
  disclosure: { x: 240, y: 1410, w: 600, h: 34 },
};

function render(ctx: Ctx, spec: VideoSpec, t: number) {
  const th = THEMES[spec.theme] ?? THEMES.neon;
  const count = countAt(spec, t);
  const pulse = beatPulse(spec, t);
  const fill = trackerFill(spec, t);
  const L = layout;
  const grad = (x0: number, x1: number) => {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, th.a);
    g.addColorStop(1, th.b);
    return g;
  };

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, spec.width, spec.height);
  glow(ctx, 180, 380 + Math.sin(t) * 40, 700, th.a, 0.1 + 0.03 * pulse);
  glow(ctx, 900, 1150 - Math.sin(t) * 40, 760, th.b, 0.12 + 0.03 * pulse);

  // --- profile header ---------------------------------------------------------
  enter(ctx, t, 0, () => {
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = font(700, 46);
    ctx.fillText(spec.profile.name, 540, L.header.y + 54);

    // avatar with progress ring
    const cx = 540;
    const cy = L.avatar.y + L.avatar.h / 2;
    const R = 146;
    ctx.lineWidth = 16;
    ctx.strokeStyle = "#262626";
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    const a0 = -Math.PI / 2;
    const a1 = a0 + Math.PI * 2 * Math.max(0.01, fill);
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = grad(cx - R, cx + R);
    ctx.shadowColor = th.b;
    ctx.shadowBlur = 22 + 26 * pulse;
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a1);
    ctx.stroke();
    ctx.restore();
    avatar(ctx, cx, cy, 118 * (1 + 0.02 * pulse), spec);

    ctx.fillStyle = "#fff";
    ctx.font = font(600, 42);
    ctx.textAlign = "center";
    ctx.fillText(spec.profile.handle, 540, L.handle.y + 46);
    floatChips(ctx, spec, t, cx + R + 44, cy + 40, th.a, 56);
  });

  // --- stats row: followers is the hero number --------------------------------
  enter(ctx, t, 0.1, () => {
    const s = L.stats;
    const cols = [s.x + 150, s.x + s.w / 2, s.x + s.w - 150];
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = font(700, 50);
    ctx.fillText(formatCount(spec.extras.following), cols[0], s.y + 92);
    ctx.fillText(shortCount(spec.extras.likes), cols[2], s.y + 92);
    withTransform(ctx, cols[1], s.y + 70, 1 + 0.03 * pulse, 1, () =>
      drawOdometer(ctx, count, cols[1], s.y + 96, 92, 800, "#fff", "center"),
    );
    ctx.font = font(500, 32);
    ctx.fillStyle = "#8a8a8a";
    ctx.fillText("Following", cols[0], s.y + 148);
    ctx.fillText("Likes", cols[2], s.y + 148);
    ctx.fillStyle = "#d6d6d6";
    ctx.fillText("Followers", cols[1], s.y + 148);
    ctx.fillStyle = "#2c2c2c";
    ctx.fillRect(s.x + 290, s.y + 50, 2, 70);
    ctx.fillRect(s.x + s.w - 292, s.y + 50, 2, 70);
  });

  // --- follow CTA ---------------------------------------------------------------
  enter(ctx, t, 0.2, () => {
    const b = L.cta;
    const done = t >= spec.tapAt + 0.12;
    withTransform(ctx, b.x + b.w / 2, b.y + b.h / 2, ctaScale(spec, t, pulse), 1, () => {
      rrect(ctx, b.x, b.y, b.w, b.h, 18);
      ctx.fillStyle = done ? "#2a2a2a" : th.cta;
      ctx.fill();
      ctx.font = font(700, 48);
      ctx.textAlign = "center";
      ctx.fillStyle = "#fff";
      if (done) {
        checkIcon(ctx, b.x + 116, b.y + b.h / 2, 40, "#fff");
        ctx.fillText("Following", b.x + b.w / 2 + 28, b.y + b.h / 2 + 17);
      } else ctx.fillText("Follow", b.x + b.w / 2, b.y + b.h / 2 + 17);
    });
    const a = L.ctaAlt;
    rrect(ctx, a.x, a.y, a.w, a.h, 18);
    ctx.fillStyle = "#2a2a2a";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(a.x + a.w / 2 - 18, a.y + a.h / 2 - 8);
    ctx.lineTo(a.x + a.w / 2, a.y + a.h / 2 + 10);
    ctx.lineTo(a.x + a.w / 2 + 18, a.y + a.h / 2 - 8);
    ctx.stroke();
  }, 0);

  // --- goal tracker -----------------------------------------------------------
  enter(ctx, t, 0.28, () => {
    const p = L.tracker;
    rrect(ctx, p.x, p.y, p.w, p.h, 30);
    ctx.fillStyle = "#121212";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.09)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = "#fff";
    ctx.font = font(800, 34);
    ctx.fillText(`${shortCount(spec.goal)} follower goal`, p.x + 40, p.y + 62);
    const pct = ((spec.trackFrom + fill * (spec.goal - spec.trackFrom)) / spec.goal) * 100;
    ctx.textAlign = "right";
    ctx.fillStyle = th.a;
    ctx.font = font(900, 46);
    ctx.fillText(`${pct.toFixed(1)}%`, p.x + p.w - 40, p.y + 66);

    const bx = p.x + 40;
    const bw = p.w - 80;
    const by = p.y + 92;
    const bh = 30;
    rrect(ctx, bx, by, bw, bh, bh / 2);
    ctx.fillStyle = "#2a2a2a";
    ctx.fill();
    const fw = Math.max(bh, bw * fill);
    ctx.save();
    ctx.shadowColor = th.b;
    ctx.shadowBlur = 18 + 26 * pulse;
    rrect(ctx, bx, by, fw, bh, bh / 2);
    ctx.fillStyle = grad(bx, bx + bw);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(bx + fw - bh / 2, by + bh / 2, 11 + 7 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.font = font(600, 28);
    ctx.fillStyle = "#8a8a8a";
    ctx.textAlign = "left";
    ctx.fillText(shortCount(spec.trackFrom).toLowerCase(), bx, p.y + p.h - 24);
    ctx.textAlign = "center";
    ctx.fillStyle = "#d6d6d6";
    ctx.fillText(`${formatCount(Math.max(0, spec.goal - Math.floor(count)))} to go`, p.x + p.w / 2, p.y + p.h - 24);
    ctx.textAlign = "right";
    ctx.fillStyle = "#8a8a8a";
    ctx.fillText(shortCount(spec.goal).toLowerCase(), bx + bw, p.y + p.h - 24);
  });

  // --- caption: label-style text blocks ------------------------------------------
  const cap = captionAt(spec, t);
  if (cap) {
    const c = L.caption;
    const { size, lines } = fitWrapped(ctx, cap.text, 800, 46, c.w - 60, 2);
    const p = prog(t, cap.t0, 0.26);
    const out = 1 - prog(t, cap.t1 - 0.12, 0.12);
    const lh = size * 1.26;
    const cy = c.y + c.h / 2;
    withTransform(ctx, 540, cy, 0.8 + 0.2 * easeOutBack(p), clamp(p * 3) * out, () => {
      ctx.font = font(800, size);
      ctx.textAlign = "center";
      lines.forEach((ln, i) => {
        const y = cy - (lines.length * lh) / 2 + i * lh;
        const w = ctx.measureText(ln).width + 44;
        rrect(ctx, 540 - w / 2, y, w, lh + 2, 16);
        ctx.fillStyle = "#fff";
        ctx.fill();
      });
      lines.forEach((ln, i) => {
        const y = cy - (lines.length * lh) / 2 + i * lh;
        ctx.fillStyle = "#111";
        ctx.fillText(ln, 540, y + size * 0.98);
      });
    });
  }

  tapPointer(ctx, spec, t, L.cta);
  disclosure(ctx, spec, L.disclosure);
}

export const tiktokTemplate: Template = {
  platform: "tiktok",
  // For-You chrome: top tabs, bottom username/caption/sound block, right rail.
  safe: { top: 200, bottom: 1450, left: 48, right: 1032, rail: { x: 930, y0: 900, y1: 1920 } },
  layout,
  themes: Object.keys(THEMES),
  render,
};
