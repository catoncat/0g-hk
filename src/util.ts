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

// ---------------------------------------------------------------------------
// Log redaction (D1)
// ---------------------------------------------------------------------------

/**
 * Query-string parameters whose VALUE is a credential.
 *
 * `edit` / `token` — the deprecated edit-token transports (1.2).
 * `key`            — `/admin/*?key=<ADMIN_KEY>`, the same class of
 *                    secret-in-a-URL, and free to fix at this seam.
 * `ts`             — the D3 challenge token.
 *
 * `[^&\s]*` stops at the next parameter or at any whitespace, so a token at the
 * end of a hono log line (`<-- GET /?edit=tk 200 1ms`) is bounded correctly and
 * the timing suffix survives. The `g` flag matters: a line can carry the same
 * secret more than once. The `i` flag matters because query-string parameter
 * names are not case-normalized anywhere upstream.
 */
const SECRET_QS_RE = /([?&](?:edit|token|key|ts)=)[^&\s]*/gi;

/**
 * Strip credential values out of one log line, keeping everything else byte
 * identical.
 *
 * The PARAMETER NAME is deliberately preserved: the line still records *that* a
 * token was presented (useful when reading logs) and — just as deliberately —
 * that makes the redaction non-vacuously testable. "No log line contains the
 * token" is trivially true when nothing was logged at all, so tests assert both
 * halves: the secret is gone AND `edit=[redacted]` is present.
 *
 * Pure and total: `String()` means a non-string argument (hono passes strings,
 * but console.log takes anything) is coerced rather than thrown on, and the
 * function is idempotent because `[redacted]` contains no `&`, no whitespace and
 * no `=`-prefixed secret name.
 */
export function redactLogLine(s) {
  return String(s == null ? "" : s).replace(SECRET_QS_RE, "$1[redacted]");
}

// ---------------------------------------------------------------------------
// Reporter grouping (D3)
// ---------------------------------------------------------------------------

/** One IPv6 group as exactly 4 lowercase hex digits. Total on any input. */
function hexGroup4(g) {
  const h = String(g == null ? "" : g).replace(/[^0-9a-f]/g, "");
  if (!h) return "0000";
  // Taking the LAST 4 hex digits is `& 0xffff` without the parse: exact for any
  // well-formed group, and stable (never NaN, never Infinity) for a malformed
  // one that is longer than four digits.
  return h.slice(-4).padStart(4, "0");
}

/**
 * Collapse a client address to the range that counts as ONE reporter: an IPv6
 * /64 or an IPv4 /24.
 *
 * This replaces the chained
 * `ip.split(":").slice(0,4).join(":").split(".").slice(0,3).join(".")`
 * truncation, which is a TEXTUAL operation on a notation that has several
 * spellings for the same address. `2001:db8::1`, `2001:db8::2` and
 * `2001:db8::3` all live in one /64 held by one actor, but `split(":")` on a
 * COMPRESSED address yields only `["2001","db8","","1"]` — four elements
 * already — so `slice(0,4)` truncates nothing and the full address, low-order
 * bits included, survives into the dedupe key. Three addresses from one
 * delegation therefore hashed to three distinct keys and counted as three
 * reporters (1.11), which is exactly how a single actor reached the
 * auto-disable threshold.
 *
 * The fix is to CANONICALIZE first and truncate second:
 *   - lowercase + trim, so casing and stray whitespace cannot fork a group;
 *   - drop any zone id (`fe80::1%eth0`), which identifies an interface, not a
 *     network;
 *   - fold an embedded trailing IPv4 (`::ffff:1.2.3.4`) into two hex groups, so
 *     the dotted and hex spellings of a mapped address agree;
 *   - expand `::` to exactly 8 groups and zero-pad each to 4 digits, so every
 *     spelling of one address produces one string.
 *
 * Total by construction: no input throws, and an unparseable value simply
 * yields a stable group of its own rather than colliding with a real one.
 */
export function reporterGroup(ip) {
  const t = String(ip == null ? "" : ip).trim().toLowerCase();
  if (!t) return "v0:unknown";

  if (t.includes(":")) {
    // A dotted quad with a port is IPv4 with transport noise, not IPv6.
    const v4WithPort = t.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (v4WithPort) return "v4:" + v4WithPort[1].split(".").slice(0, 3).join(".");

    let s = t;
    const pct = s.indexOf("%");
    if (pct >= 0) s = s.slice(0, pct);

    // Embedded trailing IPv4 -> two hex groups (::ffff:1.2.3.4 == ::ffff:102:304).
    const embedded = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (embedded) {
      const o = [embedded[2], embedded[3], embedded[4], embedded[5]].map((x) => parseInt(x, 10) & 0xff);
      s = embedded[1] + hexGroup4((((o[0] << 8) | o[1]) >>> 0).toString(16)) + ":" + hexGroup4((((o[2] << 8) | o[3]) >>> 0).toString(16));
    }

    let groups;
    const dbl = s.indexOf("::");
    if (dbl >= 0) {
      const head = s.slice(0, dbl).split(":").filter((x) => x !== "");
      const tail = s.slice(dbl + 2).split(":").filter((x) => x !== "");
      const fill = Math.max(0, 8 - head.length - tail.length);
      groups = head.concat(new Array(fill).fill("0"), tail);
    } else {
      groups = s.split(":");
    }
    while (groups.length < 8) groups.push("0");
    return "v6:" + groups.slice(0, 4).map(hexGroup4).join(":");
  }

  return "v4:" + t.split(".").slice(0, 3).join(".");
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
