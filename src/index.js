// 0g.hk — 临时笔记 + 302 短链
//
// Browser (HTML, backwards compat):
//   GET  /                              -> 编辑器
//   GET  /?c=...&n=...&ttl=...          -> 创建（HTML 结果页，同名 → 编辑器内联错误）
//   GET  <name>.0g.hk                   -> 白名单 302 / 跳转中间页 / 笔记页
//   GET  <name>.0g.hk/?go=1             -> 绕过跳转中间页
//   GET  <name>.0g.hk/?edit=<tk>&c=...  -> 以 token 覆盖（HTML 结果页）
//   GET  <name>.0g.hk/edit              -> 编辑器 UI（#t= fragment 读 token）
//
// CLI / automation (JSON + metadata headers):
//   GET  /exists?n=<name>               -> {valid, exists, reason?}
//   POST /                              -> 创建；body: application/json | form | text/plain
//   POST <name>.0g.hk/?edit=<tk>        -> 覆盖；body 同上
//   GET  <name>.0g.hk/raw               -> 原文 + 元数据 header
//   GET  <name>.0g.hk/?format=json      -> 元数据 + 原文（不含 token）
//
//   Opt-in JSON: Accept: application/json 或 ?format=json
//   Metadata headers on create/read/302:
//     X-Name, X-Short-Url, X-Raw-Url, X-Kind (url|text),
//     X-Ttl, X-Expires-At, X-Created-At, X-Target, X-Edit-Token, X-Edit-Url
//   Error JSON: {ok:false, error:{code, message, ...}}
//   OPTIONS * -> CORS preflight

const BASE_HOST = "0g.hk";
const RESERVED = new Set([
  // system paths
  "www", "api", "new", "admin", "edit", "raw", "n", "app", "abuse", "report", "exists",
  "mail", "email", "dns", "mx", "ns", "cdn", "static", "assets", "help", "docs", "status",
]);

// Substrings (case-insensitive) that indicate brand squatting / phishing intent.
// Matched by String.includes() against the requested name, so compound tokens
// like "apple-id-reset" or "metamask-login" are blocked too.
// Random names won't hit these because they're generated from a restricted alphabet.
const BRAND_BLOCK = [
  // global brands
  "apple", "icloud", "itunes", "appstore",
  "google", "gmail", "youtube",
  "microsoft", "office365", "outlook", "hotmail", "onedrive", "xbox",
  "facebook", "instagram", "whatsapp",
  "amazon", "netflix", "spotify", "disney", "linkedin",
  // finance / banking
  "paypal", "stripe", "venmo", "cashapp", "zelle",
  "visa", "mastercard", "amex",
  "chase", "wellsfargo", "hsbc", "barclays", "citibank", "santander",
  // crypto
  "binance", "coinbase", "kraken", "kucoin", "huobi", "bybit", "okex",
  "metamask", "trustwallet", "phantom", "ledger", "trezor", "uniswap",
  "usdt", "usdc",
  // CN brands
  "alipay", "zhifubao", "taobao", "tmall", "jingdong", "pinduoduo",
  "wechat", "weixin", "tencent", "douyin", "tiktok", "alibaba",
  // AI
  "openai", "chatgpt", "anthropic", "midjourney",
  // phishing verbs
  "login", "signin", "signup", "verify", "verification", "confirm",
  "secure", "support", "billing", "account", "unlock", "suspended",
  "password", "recovery", "wallet",
  // shipping scams
  "usps", "fedex", "dhl",
  // other platforms
  "dropbox", "discord", "telegram",
];

function isBrandSquatting(name) {
  const n = (name || "").toLowerCase();
  for (let i = 0; i < BRAND_BLOCK.length; i++) {
    if (n.indexOf(BRAND_BLOCK[i]) !== -1) return BRAND_BLOCK[i];
  }
  return null;
}

// Known URL shorteners / redirect services — block as redirect targets to prevent
// chaining around Safe Browsing scans.
const SHORTENER_HOSTS = new Set([
  "bit.ly", "t.co", "tinyurl.com", "goo.gl", "is.gd", "ow.ly", "buff.ly",
  "cutt.ly", "rebrand.ly", "short.io", "rb.gy", "shorturl.at", "lnkd.in",
  "tiny.cc", "t.ly", "x.gd", "v.gd", "s.id", "t2m.io", "bl.ink",
  "0g.hk",
]);

function isBlockedTargetHost(host) {
  const h = (host || "").toLowerCase();
  for (const d of SHORTENER_HOSTS) {
    if (h === d || h.endsWith("." + d)) return d;
  }
  return null;
}

// Reject URLs with dangerous/exotic schemes outright.
function hasDangerousScheme(u) {
  return /^(javascript|data|vbscript|file|blob|ftp):/i.test((u || "").trim());
}

// ---------- moderation ----------

// Auto-disable threshold: N community reports (deduped by IP/day) → soft-ban the name.
const ABUSE_AUTO_DISABLE = 3;

// Workers AI classifier. Free-tier; gated on env.AI binding.
// Returns { ok: boolean, label?: string, reason?: string, skipped?: boolean }.
// ok=false means content was classified as abusive and must be rejected.
async function aiModerate(env, kind, content, name) {
  if (!env || !env.AI) return { ok: true, skipped: true };
  // Short-circuit for trivially safe tiny text.
  if (kind === "text" && content.length < 4) return { ok: true, skipped: true };

  const cacheKey = "aimod:" + kind + ":" + (await sha256Base64Url(kind + "\n" + (name || "") + "\n" + content)).slice(0, 32);
  try {
    const cached = await env.NOTES.get(cacheKey);
    if (cached) {
      const c = JSON.parse(cached);
      return c;
    }
  } catch {}

  const system = [
    "You are a strict content-moderation classifier for a public URL shortener + paste service.",
    "Given a sub-domain NAME and CONTENT (a URL or short text), decide if it is abusive.",
    "Abusive categories: phishing, brand impersonation, malware/credential theft, illegal content,",
    "CSAM, sexual exploitation, doxxing, targeted harassment, spam payload, scam, piracy, drugs sales.",
    "Benign examples: personal notes, technical snippets, public articles, code, quotes, jokes, links to known neutral sites.",
    "Respond with ONLY a compact JSON object and nothing else:",
    '{"abuse":true|false,"label":"phishing|malware|scam|csam|illegal|spam|other|none","confidence":0.0-1.0,"reason":"<=15 words"}',
  ].join(" ");
  const user = "NAME: " + (name || "(random)") + "\nKIND: " + kind + "\nCONTENT:\n" + (content || "").slice(0, 1500);

  let result = { ok: true, skipped: false };
  try {
    const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 120,
      temperature: 0,
    });
    const raw = (r && (r.response || r.result || "")) + "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) {
      result = { ok: true, skipped: true, reason: "no_json" };
    } else {
      let j;
      try { j = JSON.parse(m[0]); } catch { j = null; }
      if (!j) {
        result = { ok: true, skipped: true, reason: "bad_json" };
      } else {
        const abuse = j.abuse === true && (typeof j.confidence !== "number" || j.confidence >= 0.55);
        result = abuse
          ? { ok: false, label: String(j.label || "other"), reason: String(j.reason || "classifier flagged").slice(0, 80), confidence: j.confidence }
          : { ok: true, label: String(j.label || "none"), confidence: j.confidence };
      }
    }
  } catch (e) {
    // Fail open: don't block legit users on AI outage.
    result = { ok: true, skipped: true, reason: "ai_error:" + String(e && e.message || e).slice(0, 40) };
  }

  try {
    await env.NOTES.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });
  } catch {}
  return result;
}

// Google Safe Browsing Lookup API v4. Gated on env.SAFE_BROWSING_KEY.
// Returns { ok: boolean, skipped?: boolean, threats?: string[] }.
async function checkSafeBrowsing(env, targetUrl) {
  const key = env && env.SAFE_BROWSING_KEY;
  if (!key) return { ok: true, skipped: true };
  try {
    const r = await fetch(
      "https://safebrowsing.googleapis.com/v4/threatMatches:find?key=" + encodeURIComponent(key),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "0g.hk", clientVersion: "1.0" },
          threatInfo: {
            threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
            platformTypes: ["ANY_PLATFORM"],
            threatEntryTypes: ["URL"],
            threatEntries: [{ url: targetUrl }],
          },
        }),
      },
    );
    if (!r.ok) return { ok: true, skipped: true, error: "http_" + r.status };
    const j = await r.json();
    const matches = (j && j.matches) || [];
    if (matches.length > 0) {
      return { ok: false, threats: matches.map((m) => String(m.threatType)) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: true, skipped: true, error: String(e && e.message || e).slice(0, 80) };
  }
}

// Cloudflare Turnstile verification. Gated on env.TURNSTILE_SECRET.
// Returns { ok: boolean, skipped?: boolean }.
async function verifyTurnstile(env, req, bodyToken) {
  const secret = env && env.TURNSTILE_SECRET;
  if (!secret) return { ok: true, skipped: true };
  const token = bodyToken || "";
  if (!token) return { ok: false, skipped: false };
  try {
    const form = new FormData();
    form.set("secret", secret);
    form.set("response", token);
    const ip = req.headers.get("cf-connecting-ip");
    if (ip) form.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const j = await r.json();
    return { ok: j && j.success === true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 80) };
  }
}
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const TEXT_MAX = 8 * 1024;
const URL_MAX = 2 * 1024;
const RATE_LIMIT = 10;

const ABUSE_EMAIL = "abuse@0g.hk";

const TTL_OPTIONS = {
  "1h": 3600,
  "1d": 86400,
  "7d": 7 * 86400,
};
const DEFAULT_TTL = "7d";
// Max TTL is 7d. Use POST <sub>.0g.hk/?edit=<token>&renew=1 to reset expiration back to full TTL.

const REDIRECT_ALLOWLIST = [
  "github.com", "gist.github.com",
  "x.com", "twitter.com",
  "youtube.com", "youtu.be",
  "google.com",
  "wikipedia.org",
  "notion.so", "notion.site",
  "apple.com",
  "cloudflare.com",
  "openai.com", "anthropic.com", "claude.ai",
  "arxiv.org",
  "chen.rs",
  BASE_HOST,
];

// ---------- utils ----------

function randomName(len = 6) {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
  return s;
}

function genToken() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let b = "";
  for (let i = 0; i < buf.length; i++) b += String.fromCharCode(buf[i]);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const arr = new Uint8Array(buf);
  let b = "";
  for (let i = 0; i < arr.length; i++) b += String.fromCharCode(arr[i]);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function ctEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

// Recognize URLs with or without scheme. Protocol-less forms like "github.com/foo"
// or "example.com" are accepted and normalized to https://... via normalizeUrl().
const URL_NO_SCHEME_RE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d+)?(?:\/\S*)?$/i;
function isUrl(s) {
  const t = (s || "").trim();
  if (/^https?:\/\//i.test(t)) return true;
  // Reject if contains whitespace or starts with punctuation that rules out a host
  if (/\s/.test(t)) return false;
  return URL_NO_SCHEME_RE.test(t);
}
// Produce the canonical stored form: always has a scheme. Non-URL input is returned unchanged.
function normalizeUrl(s) {
  const t = (s || "").trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  if (URL_NO_SCHEME_RE.test(t)) return "https://" + t;
  return t;
}
function parseUrlSafe(s) { try { return new URL(s.trim()); } catch { return null; } }

function isAllowedTarget(u) {
  const p = parseUrlSafe(u);
  if (!p) return false;
  const h = p.hostname.toLowerCase();
  return REDIRECT_ALLOWLIST.some((d) => h === d || h.endsWith("." + d));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Adaptive rate limiter. Each IP has its own per-minute bucket. If that IP has
// triggered >= ADAPTIVE_REJECT_THRESHOLD safety rejects in the last ~15m, its
// effective limit is tightened to ADAPTIVE_RATE_LIMIT for this minute window.
const ADAPTIVE_REJECT_THRESHOLD = 5;
const ADAPTIVE_RATE_LIMIT = 2;

async function rateLimit(env, ip) {
  const minute = Math.floor(Date.now() / 60000);
  const key = "rl:" + ip + ":" + minute;
  const [v, recentRej] = await Promise.all([
    env.NOTES.get(key),
    env.NOTES.get("rej-ip:" + ip),
  ]);
  const n = v ? parseInt(v, 10) + 1 : 1;
  const limit = recentRej && parseInt(recentRej, 10) >= ADAPTIVE_REJECT_THRESHOLD ? ADAPTIVE_RATE_LIMIT : RATE_LIMIT;
  if (n > limit) return false;
  await env.NOTES.put(key, String(n), { expirationTtl: 70 });
  return true;
}

// Increment per-code rejection counter (30d bucket by UTC day) and per-IP
// recent-reject counter (15m TTL) used by adaptive rate limit.
// Fire-and-forget; failures do not block the response.
function recordReject(env, code, ip) {
  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const k1 = "rej:" + day + ":" + code;
    env.NOTES.get(k1).then((v) => {
      const n = v ? parseInt(v, 10) + 1 : 1;
      return env.NOTES.put(k1, String(n), { expirationTtl: 60 * 60 * 24 * 30 });
    }).catch(() => {});
    if (ip) {
      const k2 = "rej-ip:" + ip;
      env.NOTES.get(k2).then((v) => {
        const n = v ? parseInt(v, 10) + 1 : 1;
        return env.NOTES.put(k2, String(n), { expirationTtl: 60 * 15 });
      }).catch(() => {});
    }
  } catch {}
}

// Security headers applied to every HTML response.
// CSP allows inline styles + inline scripts (legacy inline handlers in pages)
// plus the Turnstile CDN; upgrade to nonce-CSP is a future hardening step.
const SECURITY_HEADERS = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
  "content-security-policy": [
    "default-src 'self'",
    "img-src 'self' data: https://api.qrserver.com",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "connect-src 'self' https://challenges.cloudflare.com",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-robots-tag": "noindex, nofollow",
};

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: Object.assign({ "content-type": "text/html;charset=utf-8" }, SECURITY_HEADERS, extra),
  });
}

// ---------- shared HTML bits ----------

// Theme tokens (color vars + dark overrides). Shared by every page so dark mode
// is handled by a single source of truth — never hardcode light-only colors.
const THEME_CSS =
  ':root{color-scheme:light dark;--bg:#fafafa;--surface:#fff;--surface-2:#f5f5f5;--text:#111;--muted:#525252;--faint:#888;--border:#e5e5e5;--border-strong:#d4d4d4;--accent:#111;--accent-fg:#fff;--ok:#059669;--warn:#b45309;--warn-bg:#fef3c7;--warn-fg:#78350f;--warn-border:#fcd34d;--err:#dc2626;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}' +
  '@media(prefers-color-scheme:dark){:root{--bg:#0a0a0a;--surface:#141414;--surface-2:#1a1a1a;--text:#ededed;--muted:#a3a3a3;--faint:#737373;--border:#262626;--border-strong:#3a3a3a;--accent:#fff;--accent-fg:#000;--warn:#fbbf24;--warn-bg:#2a1f0a;--warn-fg:#fbbf24;--warn-border:#78350f}}';

// Shared CSS. Mobile-first, CSS custom properties, 44px+ tap targets, 16px base
// font (prevents iOS focus-zoom), respects safe-area insets.
const COMMON_CSS = [
  THEME_CSS,
  '*{box-sizing:border-box;margin:0;padding:0}',
  'html{-webkit-text-size-adjust:100%}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;background:var(--bg);color:var(--text);padding:clamp(1rem,4vw,2rem) clamp(.85rem,4vw,2rem);min-height:100vh;padding-bottom:max(clamp(1.25rem,4vw,2rem),env(safe-area-inset-bottom))}',
  '.wrap{max-width:640px;margin:0 auto}',
  '.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(1.1rem,4vw,1.75rem)}',
  'h1{font-size:clamp(1.1rem,3.2vw,1.3rem);font-weight:600;letter-spacing:-.01em;margin-bottom:.3rem}',
  '.hint{font-size:.92rem;color:var(--muted);margin-bottom:1.25rem;line-height:1.6}',
  'code{font-family:var(--mono);background:rgba(128,128,128,.14);padding:.05rem .32rem;border-radius:4px;font-size:.85em}',
  'label{display:block;font-size:.82rem;color:var(--muted);margin:0 0 .35rem;font-weight:500}',
  '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
  'input,textarea,select{width:100%;padding:.7rem .85rem;border:1px solid var(--border-strong);border-radius:8px;font-family:inherit;font-size:1rem;background:var(--surface);color:var(--text);min-height:44px}',
  'select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--faint) 50%),linear-gradient(135deg,var(--faint) 50%,transparent 50%);background-position:calc(100% - 18px) 52%,calc(100% - 13px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:2rem}',
  'input:focus,textarea:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}',
  'textarea{min-height:180px;font-family:var(--mono);font-size:.95rem;resize:vertical;line-height:1.55}',
  'button{padding:.8rem 1.25rem;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);cursor:pointer;font-size:1rem;font-weight:500;min-height:44px;font-family:inherit;-webkit-tap-highlight-color:transparent;transition:opacity .12s}',
  'button:active{transform:translateY(1px)}',
  '@media(hover:hover){button:hover{opacity:.88}}',
  'button.secondary{background:transparent;color:inherit;border:1px solid var(--border-strong);font-weight:400}',
  '@media(hover:hover){button.secondary:hover{background:rgba(128,128,128,.1)}}',
  'button[disabled]{opacity:.5;cursor:not-allowed}',
  '.foot{margin-top:1.5rem;text-align:center;font-size:.82rem;color:var(--faint)}',
  '.foot a{color:inherit;text-decoration:none;margin:0 .5rem;padding:.25rem 0;display:inline-block}',
  '.alert-warn{background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:8px;padding:.75rem 1rem;margin-bottom:1rem;color:var(--warn-fg);font-size:.9rem;line-height:1.55}',
  '.alert-warn a{color:inherit;text-decoration:underline}',
].join("\n");

function footerHtml() {
  return '<div class="foot"><a href="https://github.com/catoncat/0g-hk">GitHub</a> · <a href="https://github.com/catoncat/0g-hk/blob/main/docs/API.md">API</a> · <a href="mailto:' + ABUSE_EMAIL + '?subject=Report%20' + BASE_HOST + '">举报滥用</a></div>';
}

// Promo CTA shown on note view & 404 pages. Styles are inlined so each page keeps its own CSS scope.
function promoCardHtml() {
  return '<a class="promo" href="https://' + BASE_HOST + '/"><span class="promo-t">做一个你自己的 →</span><span class="promo-s">把文字或链接变成 <code>yours.' + BASE_HOST + '</code></span></a>';
}

const PROMO_CSS = '.promo{display:block;margin:1.75rem 0 0;padding:.9rem 1.1rem;border:1px dashed var(--border-strong);border-radius:10px;text-decoration:none;color:inherit;transition:border-color .15s,background .15s}@media(hover:hover){.promo:hover{border-color:var(--faint);background:rgba(128,128,128,.06)}}.promo-t{display:block;font-size:.95rem;font-weight:500}.promo-s{display:block;margin-top:.25rem;font-size:.78rem;color:var(--faint)}.promo-s code{font-family:var(--mono);font-size:.82rem;background:rgba(128,128,128,.1);padding:.05rem .3rem;border-radius:3px}'

// ---------- pages ----------

function editorPage(opts) {
  opts = opts || {};
  const prefillContent = opts.prefillContent || "";
  const prefillName = opts.prefillName || "";
  const prefillTtl = opts.prefillTtl || DEFAULT_TTL;
  const errorName = opts.errorName || "";
  const alertTop = opts.alertTop || "";
  // UI exposes a minimal TTL set; API still accepts all TTL_OPTIONS keys.
  const UI_TTLS = [
    { key: '1d', label: '1天' },
    { key: '7d', label: '7天' },
  ];
  const ttlSelected = UI_TTLS.some((o) => o.key === prefillTtl) ? prefillTtl : DEFAULT_TTL;
  const ttlChips = UI_TTLS.map((o) =>
    '<label class="chip"><input type="radio" name="ttl" value="' + o.key + '"' +
    (o.key === ttlSelected ? ' checked' : '') + '><span>' + o.label + '</span></label>'
  ).join('');

  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
'<meta name="theme-color" content="#fafafa" media="(prefers-color-scheme:light)">' +
'<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme:dark)">' +
'<meta name="description" content="把一段文字或链接变成 xxx.0g.hk。无账号、一次 GET 完成。">' +
'<title>' + BASE_HOST + ' — 临时笔记 · 短链</title>\n' +
'<style>\n' + COMMON_CSS + '\n' +
// Brand wordmark.
'.brand{font-family:var(--mono);font-size:clamp(2rem,7vw,2.6rem);font-weight:700;letter-spacing:-.035em;margin-bottom:.35rem;line-height:1}\n' +
'.brand .dot{color:#10b981}\n' +
// Tagline: allow inline code chip to stay on same line as verb via nowrap wrapper.
'.tagline{color:var(--muted);font-size:clamp(1rem,2.8vw,1.1rem);line-height:1.55;margin-bottom:1.5rem;max-width:34ch}\n' +
'.tagline .kw{color:var(--text);font-family:var(--mono);font-size:.92em;font-weight:500;white-space:nowrap;background:none;padding:0}\n' +
'.tagline .kw .dot{color:#10b981}\n' +
// Textarea: softer default + subtle focus ring (overrides COMMON_CSS outline).
'textarea{min-height:5rem;border-color:var(--border);font-size:.95rem}@supports(field-sizing:content){textarea{field-sizing:content;min-height:3.5rem}}\n' +
'textarea:focus{outline:0;border-color:var(--text);box-shadow:0 0 0 3px rgba(17,17,17,.06)}\n' +
'@media(prefers-color-scheme:dark){textarea:focus{box-shadow:0 0 0 3px rgba(237,237,237,.08)}}\n' +
// Field caption (small muted label above each control).
'.cap{font-size:.76rem;color:var(--faint);margin:1rem 0 .4rem;display:flex;justify-content:space-between;align-items:baseline;gap:.5rem}\n' +
'.cap .hint-r{color:var(--faint);font-size:.72rem}\n' +
// Name field (full-width, with inline .0g.hk suffix).
'.name-wrap{display:flex;align-items:stretch;border:1px solid var(--border);border-radius:8px;background:var(--surface);overflow:hidden;min-width:0;min-height:44px}\n' +
'.name-wrap:focus-within{border-color:var(--text);box-shadow:0 0 0 3px rgba(17,17,17,.06)}\n' +
'@media(prefers-color-scheme:dark){.name-wrap:focus-within{box-shadow:0 0 0 3px rgba(237,237,237,.08)}}\n' +
'.name-wrap input{flex:1;min-width:0;border:0;background:transparent;padding:0 .85rem;font:inherit;font-size:1rem;color:inherit;outline:0;min-height:unset}\n' +
'.name-wrap .suffix{font-family:var(--mono);color:var(--faint);font-size:.9rem;display:flex;align-items:center;padding:0 .85rem 0 0;white-space:nowrap;flex-shrink:0;user-select:none}\n' +
'.name-wrap.err{border-color:var(--err)}\n' +
// Status line beneath name (availability check).
'.name-status{display:block;min-height:1.1em;margin-top:.4rem;font-size:.76rem;color:var(--faint);line-height:1.4}\n' +
'.name-status.ok{color:var(--ok)}.name-status.warn{color:var(--warn)}.name-status.err{color:var(--err)}\n' +
// Action row: TTL chips (left) + submit button (right). Wraps on narrow screens.
'.action{display:flex;gap:.6rem .85rem;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:1rem}\n' +
'.ttl-row{display:flex;gap:.4rem;align-items:center;font-size:.78rem;color:var(--muted);flex-wrap:wrap}\n' +
'.ttl-row .lbl{color:var(--faint);margin-right:.25rem}\n' +
'.chip{position:relative;cursor:pointer;-webkit-tap-highlight-color:transparent}\n' +
'.chip input{position:absolute;opacity:0;pointer-events:none}\n' +
'.chip span{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 .85rem;border:1px solid var(--border);border-radius:999px;font-size:.82rem;color:var(--muted);transition:all .12s;user-select:none;background:transparent}\n' +
'@media(hover:hover){.chip:hover span{border-color:var(--muted);color:var(--text)}}\n' +
'.chip input:checked+span{background:var(--text);color:var(--bg);border-color:var(--text)}\n' +
'.chip input:focus-visible+span{outline:2px solid var(--text);outline-offset:2px}\n' +
// Primary submit button.
'.action button{min-height:44px;padding:0 1.25rem;font-size:.95rem;white-space:nowrap;flex-shrink:0}\n' +
'.type-hint{font-size:.72rem;color:var(--faint);font-family:var(--mono);margin-top:.55rem;min-height:1.1em;text-align:right;letter-spacing:.01em}\n' +
// Scenarios — tighter margin, compact cards.
'.scn{display:grid;gap:.7rem;grid-template-columns:minmax(0,1fr);margin-top:1.25rem}\n' +
'@media(min-width:760px){.scn{grid-template-columns:repeat(3,minmax(0,1fr));gap:.85rem}}\n' +
'.s-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;line-height:1.5;display:flex;flex-direction:column;gap:.4rem;min-width:0}\n' +
'.s-head{display:flex;gap:.45rem;align-items:baseline}\n' +
'.s-emoji{font-size:1rem;line-height:1;flex-shrink:0}\n' +
'.s-title{font-weight:600;color:var(--text);font-size:.9rem}\n' +
'.s-desc{color:var(--muted);font-size:.8rem;line-height:1.5}\n' +
'.s-card pre{font-family:var(--mono);font-size:.72rem;background:rgba(128,128,128,.08);padding:.55rem .65rem;border-radius:6px;color:var(--text);overflow-x:auto;white-space:pre;line-height:1.55;margin-top:auto;-webkit-overflow-scrolling:touch}\n' +
'.s-card pre::-webkit-scrollbar{height:0}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
'<div class="card">\n' +
'<div class="brand">0g<span class="dot">.</span>hk</div>\n' +
'<div class="tagline">把文字或链接，变成你的 <span class="kw">talk<span class="dot">.</span>0g<span class="dot">.</span>hk</span></div>\n' +
(alertTop ? '<div class="alert-warn">' + alertTop + '</div>\n' : '') +
'<form onsubmit="return go(event)">\n' +
'<label for="c" class="sr">内容</label>' +
'<textarea id="c" required autofocus rows="3" placeholder="粘贴文字，或 https://…">' + esc(prefillContent) + '</textarea>\n' +
'<div class="type-hint" id="typeHint"></div>\n' +
'<div class="cap"><span>子域名字</span><span class="hint-r">留空 = 随机分配</span></div>\n' +
'<div class="name-wrap' + (errorName ? ' err' : '') + '" id="nw"><input id="n" value="' + esc(prefillName) + '" autocomplete="off" inputmode="url" pattern="[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?" placeholder="talk" aria-label="自定义子域名"><span class="suffix">.' + BASE_HOST + '</span></div>' +
'<span id="ns" class="name-status' + (errorName ? ' err' : '') + '">' + esc(errorName) + '</span>\n' +
'<div class="action"><div class="ttl-row"><span class="lbl">保留</span>' + ttlChips + '</div>' +
'<button type="submit" id="submitBtn">生成 →</button></div>\n' +
'</form>\n' +
'</div>\n' +
'<section class="scn" aria-label="用法">\n' +
'<div class="s-card"><div class="s-head"><span class="s-emoji">📋</span><span class="s-title">分享临时文本</span></div><div class="s-desc">剪贴板 → 一个可分享的 URL</div><pre>pbpaste | curl -d @- 0g.hk</pre></div>\n' +
'<div class="s-card"><div class="s-head"><span class="s-emoji">🔗</span><span class="s-title">好记的短链</span></div><div class="s-desc">子域名即文案，比哈希好记 10 倍</div><pre>curl -d https://… 0g.hk/?n=talk</pre></div>\n' +
'<div class="s-card"><div class="s-head"><span class="s-emoji">🤖</span><span class="s-title">让 AI 帮你建</span></div><div class="s-desc">curl 主页直接返回说明书</div><pre>curl 0g.hk  # AI 读完就会用</pre></div>\n' +
'</section>\n' +
 footerHtml() + '\n' +
'</div>\n' +
'<script>\n' +
'var nInp=document.getElementById("n"),nw=document.getElementById("nw"),ns=document.getElementById("ns"),submitBtn=document.getElementById("submitBtn"),ta=document.getElementById("c"),th=document.getElementById("typeHint");\n' +
'var checkTimer=null,nameAvailable=null;\n' +
'function setErr(on){if(on)nw.classList.add("err");else nw.classList.remove("err")}\n' +
'function setStatus(msg,cls){ns.textContent=msg;ns.className="name-status "+(cls||"")}\n' +
// Rotating placeholder hints that name is customizable.
'var demos=["talk","q3-plan","read-me","demo","party","notes"],di=0;\n' +
'function cyclePh(){if(document.activeElement===nInp||nInp.value)return;nInp.placeholder=demos[di=(di+1)%demos.length]}\n' +
'setInterval(cyclePh,2200);cyclePh();\n' +
'function updateCta(){var v=ta.value.trim();if(!v){submitBtn.textContent="生成 →";th.textContent="";return}if(/^https?:\\/\\//i.test(v)){submitBtn.textContent="生成短链 →";th.textContent="URL · 302 短链"}else{submitBtn.textContent="生成笔记 →";th.textContent=v.length+" 字 · 笔记页"}}\n' +
'ta.addEventListener("input",updateCta);updateCta();\n' +
'function checkName(){var v=nInp.value.trim().toLowerCase();if(!v){setStatus("","");setErr(false);nameAvailable=null;return}if(!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(v)){setStatus("格式：小写字母/数字/-，2–32 位，首尾非 -","err");setErr(true);nameAvailable=false;return}setStatus("检查中…","pending");fetch("/exists?n="+encodeURIComponent(v)).then(function(r){return r.json()}).then(function(d){if(nInp.value.trim().toLowerCase()!==v)return;if(!d.valid){setStatus("不可用：保留名或格式无效","err");setErr(true);nameAvailable=false}else if(d.exists){setStatus("已被占用（本人创建请用编辑链接）","warn");setErr(false);nameAvailable=false}else{setStatus("✓ 可用","ok");setErr(false);nameAvailable=true}}).catch(function(){setStatus("","")})}\n' +
'nInp.addEventListener("input",function(){clearTimeout(checkTimer);checkTimer=setTimeout(checkName,300)});\n' +
'if(nInp.value)checkName();\n' +
'function getTtl(){var r=document.querySelector(\'input[name="ttl"]:checked\');return r?r.value:"' + DEFAULT_TTL + '"}\n' +
'function go(e){e.preventDefault();var nameVal=nInp.value.trim();if(nameVal&&nameAvailable===false){setErr(true);nInp.focus();return false}var c=ta.value;var t=getTtl();var p=new URLSearchParams();if(nameVal)p.set("n",nameVal);p.set("c",c);if(t&&t!=="' + DEFAULT_TTL + '")p.set("ttl",t);location.href="/?"+p.toString();return false}\n' +
'</script>\n' +
'</body></html>';
  return html(body);
}

function resultPage(name, content, mode, ttlKey, editToken) {
  // mode: "created" | "updated"
  const short = "https://" + name + "." + BASE_HOST;
  const editUrl = editToken ? (short + "/edit#t=" + editToken) : null;
  const link = isUrl(content);
  const typeClass = link ? "link" : "note";
  const allowed = link && isAllowedTarget(content);
  const typeLabel = link ? (allowed ? "302 直跳" : "需确认") : "笔记";
  const header = mode === "updated" ? "已更新" : "已创建";
  const ttlMap = { "1h": "1 小时", "1d": "1 天", "7d": "7 天" };
  const ttlDisplay = ttlKey ? (ttlMap[ttlKey] || ttlKey) : null;
  const qrSrc = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" + encodeURIComponent(short);
  const hostForHint = link ? ((parseUrlSafe(content) || {}).hostname || '') : '';

  // Compact edit card: title on top, inline [input + copy] row, one-line subtitle below.
  const editBlock = editUrl ? (
    '<div class="edit-card">\n' +
    '<div class="ec-h">🔑 编辑链接 · 仅此一次</div>\n' +
    '<div class="url"><input id="eu" value="' + esc(editUrl) + '" readonly onclick="this.select()"><button class="secondary" onclick="copyEdit(this)">复制</button></div>\n' +
    '<div class="ec-s">拿到这个链接的人可以修改 <code>' + esc(name) + '</code> 的内容，关掉本页就找不回来了。</div>\n' +
    '</div>\n'
  ) : '';

  // Whitelist hint — single compact line. Only shown for links.
  const whitelistBlock = (link && !allowed)
    ? ('<div class="wl wl-warn"><span class="wl-ic">🛡️</span><span><code>' + esc(hostForHint) + '</code> 不在白名单，访问者会先看到跳转确认页。</span></div>\n')
    : (link && allowed)
      ? ('<div class="wl wl-ok"><span class="wl-ic">✓</span><span><code>' + esc(hostForHint) + '</code> 在白名单，访问者直接 302 跳转。</span></div>\n')
      : '';

  // Meta rows — 2-col definition grid instead of loose br-separated lines.
  const targetRow = link
    ? ('<dt>目标</dt><dd><a href="' + esc(content.trim()) + '" rel="noopener">' + esc(content.trim().slice(0, 80)) + (content.trim().length > 80 ? '…' : '') + '</a></dd>')
    : ('<dt>长度</dt><dd>' + content.length + ' 字符</dd>');
  const ttlRow = ttlDisplay ? ('<dt>保留</dt><dd>' + esc(ttlDisplay) + '</dd>') : '';
  const metaHtml = '<dl class="meta">' +
    '<dt>原文</dt><dd><a href="' + esc(short) + '/raw">/raw</a></dd>' +
    targetRow + ttlRow +
    '</dl>';

  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + header + ' · ' + esc(name) + '</title>\n' +
'<style>\n' + COMMON_CSS + '\n' +
'.card{max-width:520px}\n' +
'h1{font-size:1.05rem;font-weight:600;margin:0 0 1rem;display:flex;gap:.5rem;align-items:center;letter-spacing:-.005em}\n' +
'h1 .dot{width:6px;height:6px;border-radius:50%;background:var(--ok);display:inline-block;flex:0 0 auto}\n' +
'.type{padding:.12rem .5rem;border-radius:999px;font-size:.7rem;font-weight:600;letter-spacing:.01em}\n' +
'.type.link{background:#e0f2fe;color:#0369a1}\n' +
'.type.note{background:#fef3c7;color:#92400e}\n' +
'@media(prefers-color-scheme:dark){.type.link{background:rgba(14,165,233,.18);color:#7dd3fc}.type.note{background:rgba(251,191,36,.18);color:#fcd34d}}\n' +
'.url{display:flex;gap:.5rem;margin-bottom:0}\n' +
'.url input{flex:1;font-family:var(--mono);font-size:.95rem;padding:.6rem .8rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);min-height:40px}\n' +
'.url button{padding:.55rem 1rem;font-size:.88rem;min-height:40px}\n' +
'.primary-url{margin-bottom:1rem}\n' +
'.edit-card{margin:0 0 1rem;padding:.85rem .95rem;border-radius:10px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);border-left:3px solid var(--warn)}\n' +
'.edit-card .ec-h{font-size:.82rem;font-weight:600;margin-bottom:.55rem;color:var(--warn)}\n' +
'.edit-card .url{margin-bottom:.55rem}\n' +
'.edit-card .ec-s{font-size:.76rem;color:var(--muted);line-height:1.5}\n' +
'.edit-card code{font-family:var(--mono);background:rgba(128,128,128,.15);padding:.02rem .28rem;border-radius:3px;font-size:.82em}\n' +
'.wl{display:flex;gap:.5rem;align-items:flex-start;margin:0 0 1rem;padding:.6rem .8rem;border-radius:8px;font-size:.8rem;line-height:1.5}\n' +
'.wl .wl-ic{flex:0 0 auto;font-size:.9rem;line-height:1.4}\n' +
'.wl code{font-family:var(--mono);background:rgba(128,128,128,.18);padding:.02rem .28rem;border-radius:3px;font-size:.9em}\n' +
'.wl.wl-warn{background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.22);color:var(--text)}\n' +
'.wl.wl-warn code{color:var(--warn)}\n' +
'.wl.wl-ok{background:rgba(5,150,105,.06);border:1px solid rgba(5,150,105,.22);color:var(--text)}\n' +
'.wl.wl-ok .wl-ic{color:var(--ok);font-weight:700}\n' +
'.meta{margin:1rem 0 0;padding:.85rem 1rem;border:1px solid var(--border);border-radius:10px;background:var(--surface);display:grid;grid-template-columns:4rem 1fr;gap:.45rem .85rem;font-size:.83rem;line-height:1.5}\n' +
'.meta dt{color:var(--faint);font-weight:500}\n' +
'.meta dd{color:var(--text);word-break:break-all;overflow:hidden;text-overflow:ellipsis}\n' +
'.meta a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--border-strong)}\n' +
'.meta a:hover{border-bottom-style:solid}\n' +
'.qr{margin:1.25rem auto 0;width:fit-content;padding:8px;border-radius:10px;background:#fff;border:1px solid var(--border)}\n' +
'.qr img{display:block;width:120px;height:120px}\n' +
'</style></head><body>\n' +
'<div class="wrap"><div class="card">\n' +
'<h1><span class="dot"></span>' + header + '<span class="type ' + typeClass + '">' + typeLabel + '</span></h1>\n' +
'<div class="url primary-url"><input id="u" value="' + esc(short) + '" readonly onclick="this.select()"><button onclick="copyShort(this)">复制</button></div>\n' +
 whitelistBlock + editBlock + metaHtml + '\n' +
'<div class="qr"><img alt="QR" src="' + esc(qrSrc) + '" width="120" height="120" loading="lazy"></div>\n' +
 footerHtml() + '\n' +
'</div></div>\n' +
'<script>function copyShort(b){navigator.clipboard.writeText(document.getElementById("u").value).then(function(){b.textContent="已复制";setTimeout(function(){b.textContent="复制"},1500)})}function copyEdit(b){navigator.clipboard.writeText(document.getElementById("eu").value).then(function(){b.textContent="已复制";setTimeout(function(){b.textContent="复制"},1500)})}</script>\n' +
'</body></html>';
  return html(body);
}

function notePage(sub, content) {
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(sub) + ' · ' + BASE_HOST + '</title>\n' +
'<meta name="robots" content="noindex">\n' +
'<style>' + THEME_CSS + '*{box-sizing:border-box;margin:0;padding:0}html{-webkit-text-size-adjust:100%}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:16px;padding:clamp(1rem,4vw,2rem) clamp(.85rem,4vw,2rem);padding-bottom:max(clamp(1rem,4vw,2rem),env(safe-area-inset-bottom));max-width:760px;margin:0 auto;line-height:1.6;background:var(--bg);color:var(--text)}\n' +
'header{display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding-bottom:.75rem;margin-bottom:1.25rem;border-bottom:1px solid var(--border);font-size:.85rem;color:var(--faint)}\n' +
'header a{color:inherit;text-decoration:none;font-family:var(--mono);word-break:break-all;flex:1;min-width:0}\n' +
'pre{white-space:pre-wrap;word-wrap:break-word;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:clamp(1rem,3vw,1.25rem);font-family:var(--mono);font-size:.95rem;line-height:1.6;color:var(--text)}\n' +
'button{padding:.5rem .85rem;min-height:36px;border:1px solid var(--border-strong);border-radius:6px;background:transparent;cursor:pointer;font-size:.82rem;color:inherit;font-family:inherit;flex:0 0 auto;-webkit-tap-highlight-color:transparent}@media(hover:hover){button:hover{background:rgba(128,128,128,.12)}}\n' +
'.foot{margin-top:1.5rem;text-align:center;font-size:.8rem;color:var(--faint)}.foot a{color:inherit;text-decoration:none;margin:0 .5rem;padding:.2rem 0;display:inline-block}\n' +
 PROMO_CSS + '\n' +
'</style></head><body>\n' +
'<header><a href="/raw">' + esc(sub) + '.' + BASE_HOST + '</a>\n' +
'<button onclick="navigator.clipboard.writeText(document.getElementById(\'c\').innerText).then(()=>{this.textContent=\'已复制\';setTimeout(()=>this.textContent=\'复制\',1200)})">复制全文</button></header>\n' +
'<pre id="c">' + esc(content) + '</pre>\n' +
 promoCardHtml() + '\n' +
 footerHtml() + '\n' +
'</body></html>';
  return html(body);
}

function interstitialPage(sub, target) {
  const parsed = parseUrlSafe(target);
  const host = parsed ? parsed.hostname : target;
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>即将跳转 · ' + BASE_HOST + '</title>\n' +
'<meta name="robots" content="noindex">\n' +
'<style>' + THEME_CSS + '*{box-sizing:border-box;margin:0;padding:0}html{-webkit-text-size-adjust:100%}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:16px;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:clamp(1rem,4vw,2rem);padding-bottom:max(clamp(1rem,4vw,2rem),env(safe-area-inset-bottom));background:var(--bg);color:var(--text)}\n' +
'.card{max-width:560px;width:100%;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(1.25rem,4vw,2rem);text-align:center}\n' +
'h1{font-size:clamp(1rem,3vw,1.15rem);margin-bottom:.5rem;font-weight:600}\n' +
'.warn{font-size:.88rem;color:var(--warn-fg);margin-bottom:1rem;line-height:1.55}\n' +
'.host{font-family:var(--mono);font-size:1.05rem;font-weight:600;color:var(--warn);word-break:break-all;line-height:1.4}\n' +
'.target{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;margin:1rem 0;font-family:var(--mono);font-size:.82rem;text-align:left;word-break:break-all;line-height:1.5;color:var(--text)}\n' +
'a.btn{display:inline-block;margin-top:.5rem;padding:.85rem 1.75rem;min-height:48px;border-radius:8px;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-size:1rem;font-weight:500;-webkit-tap-highlight-color:transparent}\n' +
'@media(hover:hover){a.btn:hover{opacity:.88}}\n' +
'.foot{margin-top:1.5rem;font-size:.8rem;color:var(--faint)}.foot a{color:inherit;text-decoration:none;margin:0 .5rem;padding:.2rem 0;display:inline-block}\n' +
'</style></head><body>\n' +
'<div class="card">\n' +
'<h1>即将离开 ' + BASE_HOST + '</h1>\n' +
'<div class="warn">此链接由用户创建，不在可信白名单。请确认目标域名：</div>\n' +
'<div class="host">' + esc(host) + '</div>\n' +
'<div class="target">' + esc(target) + '</div>\n' +
'<a class="btn" rel="noopener noreferrer nofollow" href="' + esc(target) + '">确认继续 →</a>\n' +
'<div class="foot"><a href="https://' + BASE_HOST + '/">返回首页</a> · <a href="#" onclick="return rep()">举报此链接</a></div>\n' +
'</div>\n' +
'<script>function rep(){if(!confirm("确认举报此链接为钓鱼/恶意/欺诈？"))return false;fetch("/abuse/report",{method:"POST",headers:{accept:"application/json"}}).then(function(r){return r.json()}).then(function(j){alert(j && j.disabled?"举报已提交，链接已被自动禁用。":"举报已提交，感谢协助。")}).catch(function(){alert("网络错误，稍后重试。")});return false}</script>\n' +
'</body></html>';
  return html(body);
}

function editNotePage(sub, ttlKey) {
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>编辑 ' + esc(sub) + ' · ' + BASE_HOST + '</title>\n' +
'<meta name="robots" content="noindex">\n' +
'<style>\n' + COMMON_CSS + '\n' +
'.meta{font-family:var(--mono);font-size:.85rem;color:var(--faint);margin-bottom:1rem}\n' +
'.meta strong{color:var(--text)}\n' +
'.row{display:flex;gap:.75rem;align-items:center;margin-top:1.25rem}\n' +
'.row button{flex:0 0 auto}\n' +
'.row .status{flex:1;font-size:.85rem;color:var(--faint);min-height:1.2em}\n' +
'.status.ok{color:var(--ok)}.status.err{color:var(--err)}\n' +
'.error-box{background:#fee2e2;border:1px solid #fca5a5;color:#991b1b;border-radius:8px;padding:1rem;font-size:.9rem;line-height:1.5}\n' +
'@media(prefers-color-scheme:dark){.error-box{background:#2a0e0e;border-color:#7f1d1d;color:#fca5a5}}\n' +
'</style></head><body>\n' +
'<div class="card">\n' +
'<h1>编辑笔记</h1>\n' +
'<div class="meta"><strong>' + esc(sub) + '.' + BASE_HOST + '</strong> · 保留 ' + esc(ttlKey) + '</div>\n' +
'<div id="wrap" style="display:none">\n' +
'<textarea id="c" autofocus></textarea>\n' +
'<div class="row"><button id="s" onclick="save()">保存</button><span id="st" class="status"></span></div>\n' +
'</div>\n' +
'<div id="err" class="error-box" style="display:none"></div>\n' +
 footerHtml() + '\n' +
'</div>\n' +
'<script>\n' +
'var tm=location.hash.match(/t=([A-Za-z0-9_-]+)/);\n' +
'var token=tm?tm[1]:"";\n' +
'var wrap=document.getElementById("wrap"),errBox=document.getElementById("err"),ta=document.getElementById("c"),st=document.getElementById("st"),sb=document.getElementById("s");\n' +
'function showErr(m){errBox.textContent=m;errBox.style.display=""}\n' +
'function setStatus(m,cls){st.textContent=m;st.className="status "+(cls||"")}\n' +
'if(!token){showErr("缺少编辑 token。请使用完整的编辑链接（包含 #t=...）。")}\n' +
'else{fetch("/raw").then(function(r){if(!r.ok)throw r.status;return r.text()}).then(function(t){ta.value=t;wrap.style.display=""}).catch(function(e){showErr("加载失败："+e+"。笔记可能已过期或不存在。")})}\n' +
'function save(){var c=ta.value;if(!c){setStatus("内容不能为空","err");return}sb.disabled=true;setStatus("保存中…");var u="/?edit="+encodeURIComponent(token)+"&c="+encodeURIComponent(c);fetch(u).then(function(r){sb.disabled=false;if(r.ok){setStatus("已保存 ✓","ok");setTimeout(function(){setStatus("")},2500)}else if(r.status===403){setStatus("保存失败：编辑链接无效","err")}else if(r.status===429){setStatus("保存失败：频率超限，稍后再试","err")}else{setStatus("保存失败："+r.status,"err")}}).catch(function(e){sb.disabled=false;setStatus("网络错误："+e,"err")})}\n' +
'document.addEventListener("keydown",function(e){if((e.metaKey||e.ctrlKey)&&e.key==="s"){e.preventDefault();save()}});\n' +
'</script>\n' +
'</body></html>';
  // Edit page carries an auth token in the fragment; never cache.
  return html(body, 200, { "cache-control": "no-store" });
}

function notFoundPage(sub) {
  const body = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(sub) + ' · 还没人占用</title>' +
'<meta name="robots" content="noindex">' +
'<style>' + THEME_CSS + '*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:16px;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:clamp(1rem,4vw,2rem);background:var(--bg);color:var(--text);line-height:1.6}.wrap{max-width:480px;width:100%;text-align:center}.tag{font-size:.8rem;color:var(--faint);letter-spacing:.05em;text-transform:uppercase;margin-bottom:.5rem}.sub-name{font-family:var(--mono);font-size:clamp(1.1rem,4vw,1.4rem);font-weight:600;color:var(--warn);word-break:break-all;margin-bottom:.5rem;line-height:1.3}.lead{font-size:.95rem;color:var(--muted);margin-bottom:1.5rem}' + PROMO_CSS + '.promo{margin-top:0}</style>' +
'</head><body><div class="wrap">' +
'<div class="tag">404 · 还没人占用</div>' +
'<div class="sub-name">' + esc(sub) + '.' + BASE_HOST + '</div>' +
'<div class="lead">这个子域名空着，想要么？</div>' +
'<a class="promo" href="https://' + BASE_HOST + '/?n=' + encodeURIComponent(sub) + '"><span class="promo-t">占下 ' + esc(sub) + ' →</span><span class="promo-s">把文字或链接变成你的 <code>' + esc(sub) + '.' + BASE_HOST + '</code></span></a>' +
'</div></body></html>';
  return html(body, 404);
}

// ---------- api helpers ----------

const API_VERSION = 1;

function wantsJson(req, url) {
  const f = (url.searchParams.get("format") || "").toLowerCase();
  if (f === "json") return true;
  if (f === "html") return false;
  const accept = (req.headers.get("accept") || "").toLowerCase();
  // Opt-in: Accept includes application/json AND not text/html.
  // Browsers always send text/html so they stay on HTML.
  return accept.includes("application/json") && !accept.includes("text/html");
}

// Heuristic: does this look like a real browser request?
// Used to decide whether GET / should serve the HTML homepage or a plain-text manual.
function isBrowserRequest(req) {
  const accept = (req.headers.get("accept") || "").toLowerCase();
  // Real browsers always put text/html in Accept (usually first).
  return accept.includes("text/html");
}

function llmsTextResponse() {
  const body = llmsText();
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain;charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
      "x-robots-tag": "all",
    },
  });
}

function llmsText() {
  return [
    "# 0g.hk — short links & text notes with speakable names",
    "",
    "You (AI agent / script / curl) got this plain-text manual instead of the HTML homepage",
    "because your Accept header did not include text/html. Humans see a web UI at https://0g.hk.",
    "",
    "## What this is",
    "",
    "Turn any text or URL into a readable subdomain: https://<name>.0g.hk",
    "- If content is a URL → 302 redirect when the subdomain is visited.",
    "- Otherwise → serves as a short text note (with a simple viewer).",
    "- TTL capped at 7 days. Use renew to extend before expiry.",
    "",
    "## Create (POST https://0g.hk/)",
    "",
    "Minimal (plain text body, random name, default ttl=7d):",
    "  curl -sS -X POST https://0g.hk/ \\",
    "    -H 'Accept: application/json' \\",
    "    -H 'Content-Type: text/plain' \\",
    "    --data-binary 'hello world'",
    "",
    "JSON body (choose your own subdomain):",
    "  curl -sS -X POST https://0g.hk/ \\",
    "    -H 'Content-Type: application/json' -H 'Accept: application/json' \\",
    "    -d '{\"content\":\"https://example.com\",\"name\":\"my-link\",\"ttl\":\"7d\"}'",
    "",
    "Fields:",
    "  content (required) — text (<=8KB) or http(s) URL (<=2KB).",
    "  name    (optional) — subdomain [a-z0-9-], 2–32 chars, endpoints alnum. Random 6 chars if omitted.",
    "  ttl     (optional) — one of: 1h, 1d, 7d. Default: 7d.",
    "",
    "Response (JSON) includes:",
    "  shortUrl, rawUrl, editToken, editUrl, ttl, createdAt, expiresAt, target, contentLength.",
    "  SAVE editToken — it is the ONLY way to edit or renew later, and is never shown again.",
    "",
    "Shortcut (one-line output — get just the short URL):",
    "  curl -sS -X POST 'https://0g.hk/?n=my-link' \\",
    "    -H 'Content-Type: text/plain' \\",
    "    --data-binary 'https://example.com' \\",
    "    -D - -o /dev/null | awk 'tolower($1)==\"x-short-url:\"{print $2}'",
    "",
    "## Read (GET https://<name>.0g.hk/)",
    "",
    "  curl -sSL https://<name>.0g.hk/          # follows redirect for URL notes",
    "  curl -sS  https://<name>.0g.hk/raw       # raw content (no redirect, no HTML)",
    "  curl -sS  https://<name>.0g.hk/?format=json  # full metadata + content",
    "",
    "Useful response headers: X-Kind (url|text), X-Ttl, X-Expires-At, X-Target, X-Created-At.",
    "",
    "## Edit / change TTL / renew (POST https://<name>.0g.hk/?edit=<token>)",
    "",
    "All three fields are optional. Every edit resets the expiry window to now + ttl.",
    "",
    "  # change content (ttl stays, window resets)",
    "  curl -sS -X POST 'https://<name>.0g.hk/?edit=TOKEN' \\",
    "    -H 'Content-Type: text/plain' --data-binary 'new content'",
    "",
    "  # change ttl (content stays, window resets)",
    "  curl -sS -X POST 'https://<name>.0g.hk/?edit=TOKEN&ttl=1d'",
    "",
    "  # pure renew (content+ttl stay, window resets)",
    "  curl -sS -X POST 'https://<name>.0g.hk/?edit=TOKEN&renew=1'",
    "",
    "## Check name availability",
    "",
    "  curl -sS 'https://0g.hk/exists?n=my-link'",
    "  # -> { \"valid\": true|false, \"exists\": true|false }",
    "",
    "## Rules",
    "",
    "- Rate limit: 10 req/min per IP (shared between create + edit).",
    "- URL redirects are restricted to an allowlist of hosts (github.com, x.com, youtube.com, …).",
    "  Non-allowlisted URLs are stored as text notes instead of redirects.",
    "- Reserved subdomains: www, api, new, admin, edit, raw, n, app, abuse, report, exists.",
    "- Data is deleted on expiry; no undelete.",
    "",
    "## Error format",
    "",
    "All errors when Accept: application/json is sent come back as:",
    "  { \"ok\": false, \"error\": { \"code\": \"<code>\", \"message\": \"...\", ... } }",
    "Common codes: invalid_name, reserved_name, name_taken, invalid_ttl, rate_limited,",
    "malformed_url, text_too_long, url_too_long, missing_token, invalid_token, not_editable,",
    "not_found.",
    "",
    "## Full docs",
    "",
    "https://github.com/catoncat/0g-hk/blob/main/docs/API.md",
    "Source:          https://github.com/catoncat/0g-hk",
    "Plain-text copy: https://0g.hk/llms.txt",
    "",
  ].join("\n");
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({
      "content-type": "application/json;charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    }, extraHeaders),
  });
}

function jsonError(code, message, status, extra = {}) {
  return jsonResponse({ ok: false, error: Object.assign({ code, message }, extra) }, status);
}

function replyError(req, url, code, message, status, extra = {}) {
  if (wantsJson(req, url)) return jsonError(code, message, status, extra);
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8" },
  });
}

function shortUrlFor(name) { return "https://" + name + "." + BASE_HOST; }

function expiresAtIso(ttlKey, createdAtMs) {
  const ttlSec = TTL_OPTIONS[ttlKey];
  if (!ttlSec || ttlSec <= 0 || !createdAtMs) return null;
  return new Date(createdAtMs + ttlSec * 1000).toISOString();
}

function noteMetaHeaders(o) {
  const short = shortUrlFor(o.name);
  const h = {
    "x-name": o.name,
    "x-short-url": short,
    "x-raw-url": short + "/raw",
    "x-kind": o.kind,
    "x-ttl": o.ttlKey,
    "x-expires-at": expiresAtIso(o.ttlKey, o.createdAtMs) || "never",
    "access-control-expose-headers":
      "x-name,x-short-url,x-raw-url,x-kind,x-ttl,x-expires-at,x-target,x-edit-token,x-edit-url,x-created-at",
  };
  if (o.createdAtMs) h["x-created-at"] = new Date(o.createdAtMs).toISOString();
  if (o.target) h["x-target"] = o.target;
  if (o.editToken) {
    h["x-edit-token"] = o.editToken;
    h["x-edit-url"] = short + "/edit#t=" + o.editToken;
  }
  return h;
}

async function readBody(req) {
  if (req.method !== "POST" && req.method !== "PUT") return { ok: true, body: {} };
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (ctype.startsWith("application/json")) {
      const j = await req.json();
      if (!j || typeof j !== "object") return { ok: false, err: "Invalid JSON body" };
      return { ok: true, body: {
        content: j.content != null ? String(j.content) : (j.c != null ? String(j.c) : ""),
        name: j.name != null ? String(j.name) : (j.n != null ? String(j.n) : ""),
        ttl: j.ttl != null ? String(j.ttl) : "",
        token: j.token != null ? String(j.token) : (j.edit != null ? String(j.edit) : ""),
      }};
    }
    if (ctype.startsWith("application/x-www-form-urlencoded") || ctype.startsWith("multipart/form-data")) {
      const fd = await req.formData();
      const g = (k) => fd.get(k) != null ? String(fd.get(k)) : "";
      return { ok: true, body: {
        content: g("c") || g("content"),
        name: g("n") || g("name"),
        ttl: g("ttl"),
        token: g("edit") || g("token"),
      }};
    }
    // text/plain or unknown: body IS the content
    const text = await req.text();
    return { ok: true, body: { content: text, name: "", ttl: "", token: "" } };
  } catch (e) {
    return { ok: false, err: "Failed to parse body: " + String(e && e.message || e) };
  }
}

// ---------- handlers ----------

async function handleExists(env, url) {
  const n = (url.searchParams.get("n") || "").toLowerCase().trim();
  if (!n) return jsonResponse({ valid: false, reason: "empty" });
  if (!NAME_RE.test(n) || RESERVED.has(n)) return jsonResponse({ valid: false, reason: "invalid" });
  const existing = await env.NOTES.get("n:" + n);
  return jsonResponse({ valid: true, exists: existing !== null });
}

async function handleCreate(req, env, url) {
  const bodyRes = await readBody(req);
  if (!bodyRes.ok) return replyError(req, url, "bad_body", bodyRes.err, 400);
  const bp = bodyRes.body || {};

  // Body wins when set; query string is fallback.
  let name = (bp.name || url.searchParams.get("n") || "").toLowerCase().trim();
  const rawContent = bp.content || url.searchParams.get("c") || "";
  if (!rawContent) {
    if (wantsJson(req, url)) return jsonError("missing_content", "content is required (body or ?c=)", 400);
    return editorPage();
  }

  const urlMode = isUrl(rawContent);
  // Normalize protocol-less URLs (github.com/foo -> https://github.com/foo) so stored value is canonical.
  const content = urlMode ? normalizeUrl(rawContent) : rawContent;
  if (urlMode && content.length > URL_MAX) return replyError(req, url, "url_too_long", "URL too long (max " + URL_MAX + ")", 413, { maxLength: URL_MAX });
  if (!urlMode && content.length > TEXT_MAX) return replyError(req, url, "text_too_long", "Text too long (max " + TEXT_MAX + ")", 413, { maxLength: TEXT_MAX });
  if (urlMode && !parseUrlSafe(content)) return replyError(req, url, "malformed_url", "Malformed URL", 400);

  if (name) {
    if (!NAME_RE.test(name)) return replyError(req, url, "invalid_name", "Invalid name (need [a-z0-9-]{2,32}, alnum ends)", 400);
    if (RESERVED.has(name)) return replyError(req, url, "reserved_name", "Reserved name", 400, { name });
  }

  const ttlKey = (bp.ttl || url.searchParams.get("ttl") || DEFAULT_TTL).toLowerCase();
  if (!(ttlKey in TTL_OPTIONS)) {
    return replyError(req, url, "invalid_ttl", "Invalid ttl (use " + Object.keys(TTL_OPTIONS).join("/") + ")", 400, { allowed: Object.keys(TTL_OPTIONS) });
  }
  const ttlSec = TTL_OPTIONS[ttlKey];

  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (!(await rateLimit(env, ip))) {
    return replyError(req, url, "rate_limited", "Rate limit exceeded (" + RATE_LIMIT + "/min)", 429, { limit: RATE_LIMIT, windowSeconds: 60 });
  }

  // --- abuse gates (apply only to custom names; random names are unguessable) ---
  if (name) {
    const brand = isBrandSquatting(name);
    if (brand) { recordReject(env, "brand_blocked", ip); return replyError(req, url, "brand_blocked", "Name contains a restricted brand/phishing term (" + brand + ")", 400, { term: brand }); }
  }

  if (urlMode) {
    if (hasDangerousScheme(content)) {
      recordReject(env, "bad_scheme", ip);
      return replyError(req, url, "bad_scheme", "Dangerous URL scheme", 400);
    }
    const parsed = parseUrlSafe(content);
    if (parsed) {
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        recordReject(env, "bad_scheme", ip);
        return replyError(req, url, "bad_scheme", "Only http/https URLs are allowed", 400, { scheme: parsed.protocol });
      }
      const blockedHost = isBlockedTargetHost(parsed.hostname);
      if (blockedHost) { recordReject(env, "shortener_blocked", ip); return replyError(req, url, "shortener_blocked", "Chaining URL shorteners is not allowed (" + blockedHost + ")", 400, { host: blockedHost }); }
    }
    const sb = await checkSafeBrowsing(env, content);
    if (!sb.ok && sb.threats) {
      recordReject(env, "unsafe_target", ip);
      return replyError(req, url, "unsafe_target", "Target URL flagged unsafe", 400, { threats: sb.threats });
    }
  }

  // AI moderation (Workers AI free tier). Fails open on outage.
  const aiKind = urlMode ? "url" : "text";
  const mod = await aiModerate(env, aiKind, content, name);
  if (!mod.ok) {
    recordReject(env, "content_blocked", ip);
    return replyError(req, url, "content_blocked", "Content classified as abusive by moderation", 400, { label: mod.label || "other", reason: mod.reason });
  }

  if (!name) {
    for (let i = 0; i < 6; i++) {
      const cand = randomName(6);
      if (RESERVED.has(cand)) continue;
      if (!(await env.NOTES.get("n:" + cand))) { name = cand; break; }
    }
    if (!name) return replyError(req, url, "alloc_failed", "Could not allocate name", 500);
  }

  const key = "n:" + name;
  const existing = await env.NOTES.get(key);
  if (existing !== null) {
    if (wantsJson(req, url)) return jsonError("name_taken", "Name already taken", 409, { name });
    // HTML: 同名冲突 → 编辑器内联错误，保留内容
    return editorPage({
      prefillContent: content,
      prefillName: name,
      prefillTtl: ttlKey,
      errorName: "“" + name + "” 已被占用，换一个名字。如是你本人创建的，请直接使用当时的编辑链接。",
    });
  }

  const token = genToken();
  const tokenHash = await sha256Base64Url(token);
  const createdAtMs = Date.now();
  const putOpts = ttlSec > 0 ? { expirationTtl: ttlSec } : {};
  const meta = JSON.stringify({ v: 1, h: tokenHash, t: ttlKey, ct: createdAtMs });
  await env.NOTES.put(key, content, putOpts);
  await env.NOTES.put("m:" + name, meta, putOpts);

  const kind = urlMode ? "url" : "text";
  const target = urlMode ? content.trim() : null;
  const mh = noteMetaHeaders({ name, ttlKey, createdAtMs, kind, target, editToken: token });

  if (wantsJson(req, url)) {
    return jsonResponse({
      ok: true,
      apiVersion: API_VERSION,
      name,
      kind,
      shortUrl: shortUrlFor(name),
      rawUrl: shortUrlFor(name) + "/raw",
      editToken: token,
      editUrl: shortUrlFor(name) + "/edit#t=" + token,
      ttl: ttlKey,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: expiresAtIso(ttlKey, createdAtMs),
      target,
      contentLength: content.length,
    }, 201, mh);
  }

  const r = resultPage(name, content, "created", ttlKey, token);
  for (const k in mh) r.headers.set(k, mh[k]);
  return r;
}

async function handleEdit(req, env, sub, url) {
  const bodyRes = await readBody(req);
  if (!bodyRes.ok) return replyError(req, url, "bad_body", bodyRes.err, 400);
  const bp = bodyRes.body || {};

  const token = bp.token || url.searchParams.get("edit") || "";
  let contentIn = bp.content || url.searchParams.get("c") || "";
  const renewFlag = bp.renew != null || url.searchParams.has("renew");
  if (!token) return replyError(req, url, "missing_token", "Missing edit token", 400);
  // content is optional: if omitted, existing content is reused (pure renew or ttl-only update)

  let urlMode = false;
  if (contentIn) {
    urlMode = isUrl(contentIn);
    if (urlMode) contentIn = normalizeUrl(contentIn);
    if (urlMode && contentIn.length > URL_MAX) return replyError(req, url, "url_too_long", "URL too long", 413, { maxLength: URL_MAX });
    if (!urlMode && contentIn.length > TEXT_MAX) return replyError(req, url, "text_too_long", "Text too long", 413, { maxLength: TEXT_MAX });
    if (urlMode && !parseUrlSafe(contentIn)) return replyError(req, url, "malformed_url", "Malformed URL", 400);
  }

  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (!(await rateLimit(env, ip))) {
    return replyError(req, url, "rate_limited", "Rate limit exceeded (" + RATE_LIMIT + "/min)", 429, { limit: RATE_LIMIT, windowSeconds: 60 });
  }

  const metaRawOrig = await env.NOTES.get("m:" + sub);
  if (!metaRawOrig) return replyError(req, url, "not_editable", "Not editable", 403);
  let meta;
  try { meta = JSON.parse(metaRawOrig); } catch { return replyError(req, url, "corrupt_meta", "Corrupt meta", 500); }
  const tokenHash = await sha256Base64Url(token);
  if (!ctEq(tokenHash, meta.h || "")) return replyError(req, url, "invalid_token", "Invalid edit token", 403);

  // If no new content provided, reuse existing (pure renew / ttl-only update)
  let content = contentIn;
  if (!content) {
    const existing = await env.NOTES.get("n:" + sub);
    if (existing == null) return replyError(req, url, "not_found", "Not found", 404);
    content = existing;
    urlMode = isUrl(content);
  }

  // Re-run abuse gates on edited content (content may have changed from original).
  if (contentIn) {
    if (urlMode) {
      if (hasDangerousScheme(content)) {
        recordReject(env, "bad_scheme", ip);
        return replyError(req, url, "bad_scheme", "Dangerous URL scheme", 400);
      }
      const parsed = parseUrlSafe(content);
      if (parsed) {
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          recordReject(env, "bad_scheme", ip);
          return replyError(req, url, "bad_scheme", "Only http/https URLs are allowed", 400, { scheme: parsed.protocol });
        }
        const blockedHost = isBlockedTargetHost(parsed.hostname);
        if (blockedHost) { recordReject(env, "shortener_blocked", ip); return replyError(req, url, "shortener_blocked", "Chaining URL shorteners is not allowed", 400, { host: blockedHost }); }
      }
      const sb = await checkSafeBrowsing(env, content);
      if (!sb.ok && sb.threats) {
        recordReject(env, "unsafe_target", ip);
        return replyError(req, url, "unsafe_target", "Target URL flagged unsafe", 400, { threats: sb.threats });
      }
    }
    const mod = await aiModerate(env, urlMode ? "url" : "text", content, sub);
    if (!mod.ok) {
      recordReject(env, "content_blocked", ip);
      return replyError(req, url, "content_blocked", "Content classified as abusive by moderation", 400, { label: mod.label || "other", reason: mod.reason });
    }
  }

  // Optional TTL update on edit (legacy values like "forever"/"30d"/"90d"/"1y" fall back to DEFAULT_TTL)
  const newTtlRaw = (bp.ttl || url.searchParams.get("ttl") || "").toLowerCase();
  if (newTtlRaw && !(newTtlRaw in TTL_OPTIONS)) {
    return replyError(req, url, "invalid_ttl", "Invalid ttl (use " + Object.keys(TTL_OPTIONS).join("/") + ")", 400, { allowed: Object.keys(TTL_OPTIONS) });
  }
  const ttlKey = newTtlRaw || (TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL);
  const origTtl = meta.t;
  meta.t = ttlKey;
  meta.ct = meta.ct || Date.now();
  // On renew (or any edit), reset createdAt so expiresAt reflects the new window
  if (renewFlag || newTtlRaw || contentIn) meta.ct = Date.now();
  const metaRaw = (ttlKey !== origTtl || meta.ct !== (JSON.parse(metaRawOrig).ct || 0)) ? JSON.stringify(meta) : metaRawOrig;

  const ttlSec = TTL_OPTIONS[ttlKey];
  const putOpts = ttlSec > 0 ? { expirationTtl: ttlSec } : {};
  await env.NOTES.put("n:" + sub, content, putOpts);
  await env.NOTES.put("m:" + sub, metaRaw, putOpts);

  const kind = urlMode ? "url" : "text";
  const target = urlMode ? content.trim() : null;
  const createdAtMs = meta.ct || Date.now();
  const mh = noteMetaHeaders({ name: sub, ttlKey, createdAtMs, kind, target });

  if (wantsJson(req, url)) {
    return jsonResponse({
      ok: true,
      apiVersion: API_VERSION,
      name: sub,
      kind,
      shortUrl: shortUrlFor(sub),
      rawUrl: shortUrlFor(sub) + "/raw",
      ttl: ttlKey,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: expiresAtIso(ttlKey, createdAtMs),
      target,
      contentLength: content.length,
    }, 200, mh);
  }

  const r = resultPage(sub, content, "updated", ttlKey, null);
  for (const k in mh) r.headers.set(k, mh[k]);
  return r;
}

async function handleAbuseReport(req, env, sub, url) {
  // dedupe key: (name, ip-truncated, day)
  const ip = req.headers.get("cf-connecting-ip") || "0";
  const ipTrunc = ip.split(":").slice(0, 4).join(":").split(".").slice(0, 3).join(".");
  const day = new Date().toISOString().slice(0, 10);
  const dedupeKey = "abuse-dedupe:" + sub + ":" + day + ":" + (await sha256Base64Url(ipTrunc)).slice(0, 12);
  const already = await env.NOTES.get(dedupeKey);
  const counterKey = "abuse:" + sub;
  let count = parseInt((await env.NOTES.get(counterKey)) || "0", 10) || 0;
  let disabled = false;
  if (!already) {
    count += 1;
    // Keep counter for 30 days; dedupe 1 day.
    await env.NOTES.put(counterKey, String(count), { expirationTtl: 30 * 86400 });
    await env.NOTES.put(dedupeKey, "1", { expirationTtl: 86400 });
    if (count >= ABUSE_AUTO_DISABLE) {
      // Disable marker persists longer than the note's own TTL to prevent re-use
      // of the same abusive name after expiry.
      await env.NOTES.put("d:" + sub, JSON.stringify({ reason: "community_reports", count, at: Date.now() }), { expirationTtl: 365 * 86400 });
      disabled = true;
    }
  }
  if (wantsJson(req, url)) {
    return jsonResponse({ ok: true, name: sub, reports: count, disabled, deduped: !!already });
  }
  const body = '<div class="wrap"><div class="card">' +
    '<h2 style="margin:0 0 8px">举报已提交</h2>' +
    '<p class="muted">感谢协助维护社区安全。' + (disabled ? '该链接已被自动禁用。' : ('累计举报：' + count + ' 次。')) + '</p>' +
    '<p><a class="btn ghost" href="https://' + BASE_HOST + '/">返回首页</a></p>' +
    '</div>' + footerHtml() + '</div>';
  return html(body, 200);
}

async function handleSubdomain(req, env, host, url) {
  const pathname = url.pathname;
  const sub = host.slice(0, -(BASE_HOST.length + 1));
  if (!NAME_RE.test(sub) || RESERVED.has(sub)) {
    if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404, { name: sub });
    return notFoundPage(sub);
  }

  // Abuse report endpoint: works even for disabled content.
  if (pathname === "/abuse/report") {
    return handleAbuseReport(req, env, sub, url);
  }

  // Disabled (auto-banned by reports or manual takedown): block all reads/edits.
  const disabledRaw = await env.NOTES.get("d:" + sub);
  if (disabledRaw) {
    if (wantsJson(req, url)) return jsonError("disabled", "Content disabled due to abuse reports", 410, { name: sub });
    const body = '<div class="wrap"><div class="card">' +
      '<h2 style="margin:0 0 8px">内容已禁用</h2>' +
      '<p class="muted">该短链/笔记因举报被系统自动禁用，若系误判请通过 <a href="mailto:abuse@0g.hk">abuse@0g.hk</a> 申诉。</p>' +
      '<p><a class="btn ghost" href="https://' + BASE_HOST + '/">返回首页</a></p>' +
      '</div>' + footerHtml() + '</div>';
    return html(body, 410);
  }

  // Edit via query param OR POST/PUT body
  if (url.searchParams.has("edit") || req.method === "POST" || req.method === "PUT") {
    return handleEdit(req, env, sub, url);
  }

  if (pathname === "/edit") {
    const metaRaw = await env.NOTES.get("m:" + sub);
    const existing = await env.NOTES.get("n:" + sub);
    if (existing === null) {
      if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404, { name: sub });
      return notFoundPage(sub);
    }
    let meta = {};
    try { meta = metaRaw ? JSON.parse(metaRaw) : {}; } catch {}
    const ttlKey = TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL;
    return editNotePage(sub, ttlKey);
  }

  const content = await env.NOTES.get("n:" + sub);
  if (content === null) {
    if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404, { name: sub });
    return notFoundPage(sub);
  }

  const metaRaw = await env.NOTES.get("m:" + sub);
  let meta = {};
  try { meta = metaRaw ? JSON.parse(metaRaw) : {}; } catch {}
  const ttlKey = TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL;
  const createdAtMs = meta.ct || 0;
  const urlMode = isUrl(content);
  const kind = urlMode ? "url" : "text";
  const target = urlMode ? content.trim() : null;
  const mh = noteMetaHeaders({ name: sub, ttlKey, createdAtMs, kind, target });

  if (pathname === "/raw") {
    return new Response(content, {
      headers: Object.assign({
        "content-type": "text/plain;charset=utf-8",
        "cache-control": "public, max-age=60",
      }, mh),
    });
  }

  if (wantsJson(req, url)) {
    return jsonResponse({
      ok: true,
      apiVersion: API_VERSION,
      name: sub,
      kind,
      shortUrl: shortUrlFor(sub),
      rawUrl: shortUrlFor(sub) + "/raw",
      content,
      target,
      ttl: ttlKey,
      createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
      expiresAt: expiresAtIso(ttlKey, createdAtMs),
      contentLength: content.length,
    }, 200, mh);
  }

  if (urlMode) {
    const parsed = parseUrlSafe(content);
    if (!parsed) return notePage(sub, content);
    const bypass = url.searchParams.get("go") === "1";
    if (bypass || isAllowedTarget(target)) {
      return new Response(null, {
        status: 302,
        headers: Object.assign({ location: target }, mh),
      });
    }
    return interstitialPage(sub, target);
  }
  return notePage(sub, content);
}

// Admin panel. Gated by env.ADMIN_KEY (set via `wrangler secret put ADMIN_KEY`).
// Auth: "Authorization: Bearer <ADMIN_KEY>" header OR ?key=<ADMIN_KEY> query.
// Endpoints:
//   GET  /admin/stats                    -> 30d rejection counters
//   GET  /admin/note?name=<sub>          -> inspect a note's meta
//   POST /admin/disable?name=<sub>       -> disable (410) for 365d
//   POST /admin/enable?name=<sub>        -> re-enable
async function handleAdmin(req, env, url) {
  const expected = env && env.ADMIN_KEY;
  if (!expected) return jsonError("admin_disabled", "Admin API not configured", 503);
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const provided = bearer || url.searchParams.get("key") || "";
  if (!provided || !ctEq(provided, expected)) return jsonError("unauthorized", "Invalid admin key", 401);

  const path = url.pathname;
  if (path === "/admin/stats") {
    const codes = ["brand_blocked", "bad_scheme", "shortener_blocked", "unsafe_target", "content_blocked"];
    const days = [];
    const now = Date.now();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now - i * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
      days.push(d);
    }
    const byDay = {};
    await Promise.all(days.map(async (d) => {
      const row = {};
      await Promise.all(codes.map(async (c) => {
        const v = await env.NOTES.get("rej:" + d + ":" + c);
        row[c] = v ? parseInt(v, 10) : 0;
      }));
      byDay[d] = row;
    }));
    return jsonResponse({ ok: true, days: byDay });
  }

  const name = (url.searchParams.get("name") || "").toLowerCase();
  if (!name || !NAME_RE.test(name)) return jsonError("bad_name", "Missing/invalid name", 400);

  if (path === "/admin/note" && req.method === "GET") {
    const [content, metaRaw, disabled, abuseCount] = await Promise.all([
      env.NOTES.get("n:" + name),
      env.NOTES.get("m:" + name),
      env.NOTES.get("d:" + name),
      env.NOTES.get("abuse:" + name),
    ]);
    let meta = null;
    try { meta = metaRaw ? JSON.parse(metaRaw) : null; } catch {}
    return jsonResponse({
      ok: true,
      name,
      exists: content != null,
      disabled: !!disabled,
      abuseCount: abuseCount ? parseInt(abuseCount, 10) : 0,
      kind: meta && meta.k,
      ttl: meta && meta.t,
      createdAt: meta && meta.c ? new Date(meta.c).toISOString() : null,
      content,
    });
  }

  if (path === "/admin/disable" && req.method === "POST") {
    await env.NOTES.put("d:" + name, "admin", { expirationTtl: 60 * 60 * 24 * 365 });
    return jsonResponse({ ok: true, name, disabled: true });
  }

  if (path === "/admin/enable" && req.method === "POST") {
    await env.NOTES.delete("d:" + name);
    await env.NOTES.delete("abuse:" + name);
    return jsonResponse({ ok: true, name, disabled: false });
  }

  return jsonError("not_found", "Unknown admin endpoint", 404);
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
      "access-control-allow-headers": "content-type, accept",
      "access-control-max-age": "86400",
    },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();

    if (req.method === "OPTIONS") return corsPreflight();

    if (host === BASE_HOST) {
      if (url.pathname === "/exists") return handleExists(env, url);
      if (url.pathname.startsWith("/admin/")) return handleAdmin(req, env, url);
      if (url.pathname === "/llms.txt" || url.pathname === "/robots.txt" && url.searchParams.has("llms")) {
        return llmsTextResponse();
      }
      if (url.pathname === "/" || url.pathname === "") {
        if (req.method === "POST" || req.method === "PUT" ||
            url.searchParams.has("c")) {
          return handleCreate(req, env, url);
        }
        // Content negotiation: non-browser clients (curl, AI agents, scripts) get
        // a plain-text usage manual instead of the HTML homepage.
        if (req.method === "GET" && !isBrowserRequest(req)) {
          return llmsTextResponse();
        }
        return editorPage({
          prefillName: (url.searchParams.get("n") || "").toLowerCase().trim(),
          prefillContent: url.searchParams.get("c") || "",
        });
      }
      if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404);
      return new Response("Not found", { status: 404 });
    }
    if (host.endsWith("." + BASE_HOST)) return handleSubdomain(req, env, host, url);

    if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404);
    return new Response("Not found", { status: 404 });
  },
};
