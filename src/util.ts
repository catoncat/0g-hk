// Generic helpers: random names, crypto, URL parsing, escaping, rate limit, reject telemetry.
import { BASE_HOST, BRAND_BLOCK, SHORTENER_HOSTS, NAME_RE, RATE_LIMIT, ADAPTIVE_RATE_LIMIT, ADAPTIVE_REJECT_THRESHOLD, TTL_OPTIONS, REDIRECT_ALLOWLIST } from "./constants.js";

export function isBrandSquatting(name) {
  const n = name.toLowerCase();
  for (const t of BRAND_BLOCK) if (n.includes(t)) return t;
  return null;
}

export function isBlockedTargetHost(hostname) {
  if (!hostname) return null;
  const h = hostname.toLowerCase();
  for (const s of SHORTENER_HOSTS) {
    if (h === s || h.endsWith("." + s)) return s;
  }
  return null;
}

export function hasDangerousScheme(s) {
  const t = String(s || "").trim().toLowerCase();
  return t.startsWith("javascript:") || t.startsWith("data:") || t.startsWith("vbscript:") || t.startsWith("file:");
}

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export function randomName(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  // Ensure first/last are alphanumeric (they are by construction).
  return s;
}

export function genToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const arr = new Uint8Array(buf);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function ctEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const URL_NO_SCHEME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?(\/[^\s]*)?$/i;
export function isUrl(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (/\s/.test(t)) return false;
  return URL_NO_SCHEME_RE.test(t);
}

// ---------------------------------------------------------------------------
// Note kind (D4)
//
// The url-vs-text decision used to be re-derived from the content at every
// call site (create, edit, read, admin, result page), which let the same note
// be classified differently depending on who asked and when. These two helpers
// are the only derivations: `resolveKind` at write time, `readKind` at read
// time.
// ---------------------------------------------------------------------------

/** The persisted `k` field of `m:<name>`. */
export type NoteKind = "url" | "text";

/**
 * Write-time authority: classify content that is being stored right now.
 *
 * This is exactly today's `isUrl(content)` decision, named once so that the
 * value written to `m:<name>.k` and the branch taken by the writer cannot
 * disagree.
 */
export function resolveKind(content): NoteKind {
  return isUrl(content) ? "url" : "text";
}

/**
 * Read-time authority: trust the persisted kind, fall back for legacy records.
 *
 * `meta.k` is honoured only when it is exactly `"url"` or `"text"`. Guarding on
 * the two literals — rather than on `meta.k` being truthy — means a corrupt or
 * unknown value (`"URL"`, `1`, `null`, `{}`) degrades to the pre-fix derivation
 * instead of selecting an undefined branch. `meta` itself may be anything
 * `JSON.parse` returned, including `null`, so it is probed defensively.
 */
export function readKind(meta, content): NoteKind {
  if (meta != null && (meta.k === "url" || meta.k === "text")) return meta.k;
  return resolveKind(content);
}

export function normalizeUrl(s) {
  const t = String(s || "").trim();
  if (/^https?:\/\//i.test(t)) return t;
  return "https://" + t;
}

export function parseUrlSafe(s) {
  try { return new URL(s); } catch { return null; }
}

export function isAllowedTarget(target) {
  const u = parseUrlSafe(target);
  if (!u) return false;
  const h = u.hostname.toLowerCase();
  return REDIRECT_ALLOWLIST.some((d) => h === d || h.endsWith("." + d));
}

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function rateLimit(env, ip) {
  const minute = Math.floor(Date.now() / 60000);
  const key = "rl:" + ip + ":" + minute;
  const rejKey = "rej-ip:" + ip;
  const [curRaw, recentRejRaw] = await Promise.all([
    env.NOTES.get(key),
    env.NOTES.get(rejKey),
  ]);
  const cur = parseInt(curRaw || "0", 10) || 0;
  // Adaptive: if this IP has been rejected too many times recently, tighten its per-minute cap.
  const recentRej = parseInt(recentRejRaw || "0", 10) || 0;
  const cap = recentRej >= ADAPTIVE_REJECT_THRESHOLD ? ADAPTIVE_RATE_LIMIT : RATE_LIMIT;
  if (cur >= cap) return false;
  await env.NOTES.put(key, String(cur + 1), { expirationTtl: 70 });
  return true;
}

// Record a rejection: both daily-by-code (stats) and per-IP (adaptive cap).
export async function recordReject(env, code, ip) {
  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const k = "rej:" + day + ":" + code;
    const cur = parseInt((await env.NOTES.get(k)) || "0", 10) || 0;
    await env.NOTES.put(k, String(cur + 1), { expirationTtl: 30 * 86400 });
    if (ip) {
      const ipKey = "rej-ip:" + ip;
      const ipCur = parseInt((await env.NOTES.get(ipKey)) || "0", 10) || 0;
      await env.NOTES.put(ipKey, String(ipCur + 1), { expirationTtl: 15 * 60 });
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Background work (D2)
// ---------------------------------------------------------------------------

/**
 * A tiny facade over the platform's `ExecutionContext.waitUntil`, handed to the
 * write handlers so telemetry writes (`recordReject`) survive the response.
 *
 * `waitUntil(p)` registers background work; `settle()` resolves once every
 * promise this facade is still responsible for has finished. With a real
 * ExecutionContext the runtime owns the promises and `settle()` resolves
 * immediately; without one it owns them itself and `settle()` awaits them.
 */
export interface Background {
  waitUntil(p: unknown): void;
  settle(): Promise<void>;
}

/**
 * Build a Background facade.
 *
 * `exeCtx.waitUntil` is used when the platform supplied one. It is not
 * guaranteed to exist: hono's `c.executionCtx` getter throws when the context
 * was built without one, and unit-style tests call handlers directly. In that
 * case the work is queued and awaited by `settle()` instead, so the write still
 * completes before the response is handed back — a few milliseconds in tests,
 * and never in production.
 *
 * Every queued promise is wrapped in `.catch(ignore)`, so a failing telemetry
 * write can neither reject out of `settle()` nor surface as an unhandled
 * rejection.
 */
export function makeBackground(exeCtx): Background {
  const pending: Promise<void>[] = [];
  const hasCtx = exeCtx != null && typeof exeCtx.waitUntil === "function";
  return {
    waitUntil(p) {
      const q = Promise.resolve(p).then(
        () => {},
        () => {},
      );
      if (hasCtx) exeCtx.waitUntil(q);
      else pending.push(q);
    },
    async settle() {
      if (!pending.length) return;
      await Promise.all(pending.splice(0));
    },
  };
}

export function shortUrlFor(name) {
  return "https://" + name + "." + BASE_HOST;
}

export function expiresAtIso(ttlKey, createdAtMs) {
  const ttlSec = TTL_OPTIONS[ttlKey];
  if (!ttlSec || ttlSec <= 0 || !createdAtMs) return null;
  return new Date(createdAtMs + ttlSec * 1000).toISOString();
}

export { NAME_RE };

export function normalizeName(s) {
  return String(s || "").replace(/[_\s]+/g, "-").toLowerCase();
}
