import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileSha256 } from "../engine/encode.ts";

/**
 * Media hosting on Cloudflare R2.
 *
 * Buffer has no upload endpoint: it fetches each video from a public HTTPS URL
 * at publish time. This uploads MP4s to an R2 bucket through the Cloudflare
 * API and returns the bucket's public URL for each. Endpoints verified against
 * a live account on 2026-11-21:
 *   PUT /accounts/{account}/r2/buckets/{bucket}/objects/{key}
 *   public read via the bucket's r2.dev domain (or a custom domain)
 *
 * Credentials stay in the environment; nothing here is written to the repo.
 */
export interface MediaConfig {
  accountId: string;
  apiToken: string;
  bucket: string;
  /** public https:// prefix of the bucket, no trailing slash needed */
  publicBaseUrl: string;
  fetchImpl?: typeof fetch;
}

export function mediaConfigFromEnv(env: NodeJS.ProcessEnv = process.env, defaults: { bucket?: string; publicBaseUrl?: string } = {}): MediaConfig {
  const bucket = env.R2_BUCKET ?? defaults.bucket;
  const publicBaseUrl = env.MEDIA_BASE_URL ?? defaults.publicBaseUrl;
  const missing = [
    !env.CLOUDFLARE_ACCOUNT_ID && "CLOUDFLARE_ACCOUNT_ID",
    !env.CLOUDFLARE_API_TOKEN && "CLOUDFLARE_API_TOKEN",
    !bucket && "R2_BUCKET",
    !publicBaseUrl && "MEDIA_BASE_URL",
  ].filter(Boolean);
  if (missing.length) throw new Error(`media upload needs ${missing.join(", ")} in the environment`);
  if (!/^https:\/\//.test(publicBaseUrl!)) throw new Error("MEDIA_BASE_URL must be a public https:// URL");
  return { accountId: env.CLOUDFLARE_ACCOUNT_ID!, apiToken: env.CLOUDFLARE_API_TOKEN!, bucket: bucket!, publicBaseUrl: publicBaseUrl! };
}

/** The account id is not a secret, but it need not live in the repo: look it up with the token when unset. */
export async function discoverAccountId(apiToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("https://api.cloudflare.com/client/v4/accounts", { headers: { Authorization: `Bearer ${apiToken}` } });
  const body = (await res.json().catch(() => ({}))) as { result?: { id: string }[] };
  if (!res.ok || !body.result?.length) throw new Error(`could not look up the Cloudflare account (HTTP ${res.status}); set CLOUDFLARE_ACCOUNT_ID`);
  return body.result[0].id;
}

/** Content-addressed key: re-uploading the same file is a no-op, and a URL never changes meaning. */
export function mediaKey(file: string, prefix = "vts"): string {
  return `${prefix}/${basename(file, ".mp4")}-${fileSha256(file).slice(0, 12)}.mp4`;
}

export const publicUrl = (cfg: Pick<MediaConfig, "publicBaseUrl">, key: string) =>
  `${cfg.publicBaseUrl.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;

export interface Verification {
  ok: boolean;
  status: number;
  contentType: string | null;
  bytes: number | null;
  problem: string | null;
}

/**
 * Fetch the URL the way a third party would: no credentials, plain GET.
 * Passes only if it returns 200 with a video content type and the exact size.
 */
export async function verifyPublicUrl(url: string, expectedBytes: number, fetchImpl: typeof fetch = fetch): Promise<Verification> {
  const res = await fetchImpl(url, { method: "GET", redirect: "follow" });
  const contentType = res.headers.get("content-type");
  const body = res.ok ? await res.arrayBuffer() : null;
  const bytes = body ? body.byteLength : null;
  const problem = !res.ok
    ? `HTTP ${res.status}`
    : !contentType?.startsWith("video/")
      ? `content-type ${contentType}`
      : bytes !== expectedBytes
        ? `size ${bytes} != ${expectedBytes}`
        : null;
  return { ok: problem === null, status: res.status, contentType, bytes, problem };
}

export async function uploadVideo(file: string, cfg: MediaConfig, prefix?: string): Promise<{ key: string; url: string; bytes: number; verification: Verification }> {
  const f = cfg.fetchImpl ?? fetch;
  const key = mediaKey(file, prefix);
  const bytes = statSync(file).size;
  const url = publicUrl(cfg, key);
  // already there with the right size? then skip the upload
  let v = await verifyPublicUrl(url, bytes, f).catch(() => null);
  if (!v?.ok) {
    const api = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/r2/buckets/${cfg.bucket}/objects/${key}`;
    const res = await f(api, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cfg.apiToken}`, "Content-Type": "video/mp4" },
      body: readFileSync(file),
    });
    const out = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: { message: string }[] };
    if (!res.ok || !out.success) throw new Error(`R2 upload failed (HTTP ${res.status}): ${out.errors?.[0]?.message ?? "unknown error"}`);
    v = await verifyPublicUrl(url, bytes, f);
  }
  if (!v.ok) throw new Error(`uploaded but not publicly retrievable: ${url} (${v.problem})`);
  return { key, url, bytes, verification: v };
}
