import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RemotePost } from "./publish/buffer.ts";
import type { QueueItem } from "./publish/queue.ts";

/**
 * Experiment ledger: one row per post, with the dimensions we vary (caption,
 * audio, template variant) and the outcome metrics. Stored as a plain CSV so
 * it can be opened in a spreadsheet, filled in by hand from YouTube Studio /
 * TikTok Studio, and imported back.
 */
export const COLUMNS = [
  "platform",
  "post_id",
  "video_id",
  "publish_date",
  "caption",
  "audio_id",
  "template_variant",
  "count_tier",
  "final_count",
  "length_tier",
  "post_time",
  "views",
  "viewed_rate",
  "avg_watch_pct",
  "followers_gained",
  "shares",
  "post_url",
  "source",
] as const;
export type Column = (typeof COLUMNS)[number];
export type Row = Record<Column, string>;

/** Outcome columns; an import may only change these (plus post_id / post_url). */
export const METRICS = ["views", "viewed_rate", "avg_watch_pct", "followers_gained", "shares"] as const;

// ---------- CSV ----------------------------------------------------------------

const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(rows: Row[]): string {
  return [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => esc(r[c] ?? "")).join(","))].join("\n") + "\n";
}

export function parseCsv(text: string): Record<string, string>[] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") (row.push(cell), (cell = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c !== "")) out.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) out.push(row);
  const [head, ...body] = out;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export function readLedger(path: string): Row[] {
  if (!existsSync(path)) return [];
  return parseCsv(readFileSync(path, "utf8")).map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? ""])) as Row);
}

export function writeLedger(path: string, rows: Row[]) {
  mkdirSync(dirname(path), { recursive: true });
  const sorted = [...rows].sort((a, b) => (a.publish_date + a.platform + a.video_id).localeCompare(b.publish_date + b.platform + b.video_id));
  writeFileSync(path, toCsv(sorted));
}

// ---------- building / merging ---------------------------------------------------

const keyOf = (r: { platform: string; video_id: string }) => `${r.platform}|${r.video_id}`;

/** Add or refresh rows from the publish queue. Existing metric values are kept. */
export function syncFromQueue(rows: Row[], items: QueueItem[], opts: { includeUnpublished?: boolean } = {}): Row[] {
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  for (const i of items) {
    if (!opts.includeUnpublished && i.status !== "scheduled") continue;
    const prev = byKey.get(keyOf({ platform: i.platform, video_id: i.videoId }));
    byKey.set(keyOf({ platform: i.platform, video_id: i.videoId }), {
      platform: i.platform,
      post_id: i.remoteId ?? prev?.post_id ?? "",
      video_id: i.videoId,
      publish_date: (i.published?.sentAt ?? i.dueAt).slice(0, 10),
      caption: i.caption,
      audio_id: i.audioId ?? "",
      template_variant: i.variant,
      count_tier: i.countTier ?? "",
      final_count: prev?.final_count ?? "",
      length_tier: i.lengthTier ?? prev?.length_tier ?? "",
      // local posting time as scheduled (HH:MM), for comparing times of day
      post_time: i.dueAt.slice(11, 16),
      views: prev?.views ?? "",
      viewed_rate: prev?.viewed_rate ?? "",
      avg_watch_pct: prev?.avg_watch_pct ?? "",
      followers_gained: prev?.followers_gained ?? "",
      shares: prev?.shares ?? "",
      post_url: i.published?.externalLink ?? prev?.post_url ?? "",
      source: prev?.source ?? "",
    });
  }
  return [...byKey.values()];
}

/** Accepts "1,234", "45%", "45.2" -> canonical number string; "" stays empty. */
export function cleanNumber(v: string, column: string): string {
  if (v === "" || v === "-" || v.toLowerCase() === "n/a") return "";
  const n = Number(v.replace(/[,%\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new Error(`${column}: "${v}" is not a non-negative number`);
  return String(n);
}

/**
 * Merge metrics typed in from the platform dashboards. Rows match on
 * platform + video_id, or on post_id. Only outcome columns (and post_url) are
 * taken from the import; experiment dimensions cannot be overwritten.
 */
export function importMetrics(rows: Row[], incoming: Record<string, string>[], source = "manual"): { rows: Row[]; updated: number; unmatched: string[] } {
  const byKey = new Map(rows.map((r) => [keyOf(r), r]));
  const byPost = new Map(rows.filter((r) => r.post_id).map((r) => [r.post_id, r]));
  let updated = 0;
  const unmatched: string[] = [];
  for (const inc of incoming) {
    const target = byKey.get(`${inc.platform}|${inc.video_id}`) ?? (inc.post_id ? byPost.get(inc.post_id) : undefined);
    if (!target) {
      unmatched.push(inc.video_id || inc.post_id || "(row without id)");
      continue;
    }
    let changed = false;
    for (const m of METRICS) {
      if (inc[m] === undefined || inc[m] === "") continue;
      const v = cleanNumber(inc[m], m);
      if (v !== target[m]) (target[m] = v), (changed = true);
    }
    if (inc.post_url && inc.post_url !== target.post_url) (target.post_url = inc.post_url), (changed = true);
    if (changed) {
      target.source = source;
      updated++;
    }
  }
  return { rows, updated, unmatched };
}

/**
 * Fill what Buffer reports for a post. Viewed/swiped rate and watch % are not in Buffer's metrics.
 *  - only posts Buffer has actually sent count; a post still waiting has no results
 *  - counts only ever go up, so a number already recorded (e.g. typed in from
 *    the platform's own dashboard) is never replaced by a smaller one
 *  - Buffer's metrics refresh about daily, so a zero in the first 48 hours is
 *    treated as "not reported yet", not as a result
 */
export function applyBufferMetrics(row: Row, post: RemotePost, now = new Date()): boolean {
  if (post.status !== "sent") return false;
  const fresh = !post.sentAt || now.getTime() - Date.parse(post.sentAt) < 48 * 3600 * 1000;
  const get = (t: string) => post.metrics.find((m) => m.type === t)?.value;
  let changed = false;
  const set = (c: Column, v: number | null | undefined) => {
    if (v === null || v === undefined) return;
    if (v === 0 && fresh) return;
    if (row[c] !== "" && Number(row[c]) >= v) return;
    row[c] = String(v);
    changed = true;
  };
  set("views", get("views"));
  set("shares", get("shares"));
  set("followers_gained", get("follows"));
  if (post.externalLink && row.post_url !== post.externalLink) (row.post_url = post.externalLink), (changed = true);
  if (changed && row.source !== "manual") row.source = "buffer";
  return changed;
}

// ---------- reporting --------------------------------------------------------------

export interface Group {
  key: string;
  posts: number;
  withData: number;
  views: number;
  avgViews: number | null;
  avgViewedRate: number | null;
  avgWatchPct: number | null;
  followersPer1kViews: number | null;
  sharesPer1kViews: number | null;
}

const num = (v: string) => (v === "" ? null : Number(v));
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null;
};

/** Compare captions, sounds or template variants. Rates are per 1,000 views. */
export function summarize(rows: Row[], by: "platform" | "caption" | "audio_id" | "template_variant" | "count_tier" | "length_tier" | "post_time"): Group[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = by === "platform" ? r.platform : `${r.platform} · ${r[by] || "(none)"}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([key, rs]) => {
      const withViews = rs.filter((r) => num(r.views) !== null);
      const views = withViews.reduce((a, r) => a + Number(r.views), 0);
      const per1k = (c: Column) => {
        const have = withViews.filter((r) => num(r[c]) !== null);
        const v = have.reduce((a, r) => a + Number(r.views), 0);
        return v > 0 ? +((have.reduce((a, r) => a + Number(r[c]), 0) / v) * 1000).toFixed(2) : null;
      };
      return {
        key,
        posts: rs.length,
        withData: withViews.length,
        views,
        avgViews: withViews.length ? Math.round(views / withViews.length) : null,
        avgViewedRate: mean(rs.map((r) => num(r.viewed_rate))),
        avgWatchPct: mean(rs.map((r) => num(r.avg_watch_pct))),
        followersPer1kViews: per1k("followers_gained"),
        sharesPer1kViews: per1k("shares"),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}
