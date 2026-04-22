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
  const cur = parseInt((await env.NOTES.get(key)) || "0", 10) || 0;
  // Adaptive: if this IP has been rejected too many times recently, tighten its per-minute cap.
  const rejKey = "rej-ip:" + ip;
  const recentRej = parseInt((await env.NOTES.get(rejKey)) || "0", 10) || 0;
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
