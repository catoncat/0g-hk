// Response helpers: security headers, html/json responses, CSS theme, footer/promo, llms.txt,
// note-meta headers, and request body parsing.
import { BASE_HOST, API_VERSION, TTL_OPTIONS, TEXT_MAX, URL_MAX, RATE_LIMIT, DEFAULT_TTL, ABUSE_EMAIL } from "./constants.js";
import { shortUrlFor, expiresAtIso } from "./util.js";

// Baseline security headers applied to every HTML response.
export const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; " +
    "img-src 'self' data: https://api.qrserver.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; " +
    "frame-src https://challenges.cloudflare.com; " +
    "connect-src 'self' https://challenges.cloudflare.com; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
  "x-robots-tag": "noindex, nofollow",
};

export function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: Object.assign({
      "content-type": "text/html;charset=utf-8",
      "cache-control": "no-store",
    }, SECURITY_HEADERS, extraHeaders),
  });
}

export const THEME_CSS = `:root{color-scheme:light dark;--bg:#fafaf7;--surface:#fff;--surface-2:#f4f4ef;--text:#191918;--muted:#6b6b66;--faint:#a8a8a0;--border:#e7e5df;--border-strong:#d8d5cc;--accent:#111;--accent-fg:#fff;--ok:#2f7a3a;--warn:#8a5a00;--warn-bg:#fff7e0;--warn-fg:#5a3b00;--warn-border:#f0d48a;--err:#b02a2a;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme: dark){:root{--bg:#0f0f0e;--surface:#1a1a18;--surface-2:#232320;--text:#ecece8;--muted:#9a9a93;--faint:#5b5b56;--border:#2b2b27;--border-strong:#3a3a35;--accent:#ecece8;--accent-fg:#111;--ok:#5ad06a;--warn:#e5b74a;--warn-bg:#3b2e10;--warn-fg:#f2d78a;--warn-border:#6a531a;--err:#e07070}}`;

export const COMMON_CSS = THEME_CSS + `
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.55}
.wrap{max-width:760px;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:24px 22px;margin:0 0 16px}
h1{font-size:22px;margin:0 0 8px;letter-spacing:-0.01em}
h2{font-size:18px;margin:0 0 12px;letter-spacing:-0.01em}
p{margin:0 0 10px}
.muted{color:var(--muted);font-size:13px}
.faint{color:var(--faint);font-size:12px}
.mono{font-family:var(--mono);font-size:13px}
.btn{display:inline-block;padding:9px 14px;border-radius:8px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);text-decoration:none;cursor:pointer;font-size:14px;font-family:inherit}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.btn.ghost{background:transparent}
.btn:hover{filter:brightness(0.97)}
.input,textarea{width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--border-strong);background:var(--surface-2);color:var(--text);font-family:inherit;font-size:14px}
textarea{resize:vertical;min-height:120px;font-family:var(--mono);font-size:13px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.err{color:var(--err);font-size:13px;margin:6px 0 0}
.ok{color:var(--ok)}
.warn{background:var(--warn-bg);color:var(--warn-fg);border:1px solid var(--warn-border);border-radius:8px;padding:10px 12px;font-size:13px}
@media (max-width:560px){body{padding:12px 10px}.card{padding:16px 14px;border-radius:12px}h1{font-size:20px}}`;

export function footerHtml() {
  return '<div class="wrap" style="margin-top:24px"><p class="faint" style="text-align:center">' +
    '<a class="faint" href="https://' + BASE_HOST + '/" style="color:inherit">' + BASE_HOST + '</a> · ' +
    '<a class="faint" href="mailto:' + ABUSE_EMAIL + '" style="color:inherit">举报</a> · ' +
    '<a class="faint" href="https://' + BASE_HOST + '/llms.txt" style="color:inherit">llms.txt</a>' +
    '</p></div>';
}

export function promoCardHtml() {
  return '<div class="wrap"><div class="card" style="border-style:dashed"><p class="muted" style="margin:0">' +
    '<strong>开发者？</strong> 本站是一个极简短链 / 笔记服务，支持 REST、curl 一行创建，见 ' +
    '<a href="https://' + BASE_HOST + '/llms.txt" style="color:inherit">llms.txt</a>。' +
    '</p></div></div>';
}

// API + JSON helpers
export function wantsJson(req, url) {
  if (url.searchParams.get("format") === "json") return true;
  const accept = (req.headers.get("accept") || "").toLowerCase();
  if (accept.includes("application/json")) return true;
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.startsWith("application/json")) return true;
  return false;
}

export function isBrowserRequest(req) {
  const accept = (req.headers.get("accept") || "").toLowerCase();
  const ua = (req.headers.get("user-agent") || "").toLowerCase();
  if (accept.includes("text/html")) return true;
  if (/mozilla|chrome|safari|firefox|edg\//.test(ua)) return true;
  return false;
}

export function jsonResponse(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({
      "content-type": "application/json;charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    }, extra),
  });
}

export function jsonError(code, message, status = 400, details) {
  const body = { ok: false, error: { code, message } };
  if (details && typeof details === "object") body.error.details = details;
  return jsonResponse(body, status);
}

export function replyError(req, url, code, message, status, details) {
  if (wantsJson(req, url)) return jsonError(code, message, status, details);
  const body = '<div class="wrap"><div class="card">' +
    '<h2 style="margin:0 0 8px">失败了</h2>' +
    '<p class="err" style="margin:0 0 8px">' + message + '</p>' +
    '<p class="muted">错误码：<span class="mono">' + code + '</span></p>' +
    '<p><a class="btn ghost" href="https://' + BASE_HOST + '/">返回首页</a></p>' +
    '</div>' + footerHtml() + '</div>';
  return html(body, status);
}

// ---- note meta HTTP headers ----
export function noteMetaHeaders(o) {
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

// Parse request body from JSON / form / text. Body fields win over query string.
export async function readBody(req) {
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
        renew: j.renew != null ? (j.renew === true || j.renew === "1" || j.renew === "true") : undefined,
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
        renew: fd.get("renew") != null ? true : undefined,
      }};
    }
    const text = await req.text();
    return { ok: true, body: { content: text, name: "", ttl: "", token: "" } };
  } catch (e) {
    return { ok: false, err: "Failed to parse body: " + String(e && e.message || e) };
  }
}

// ---- llms.txt ----
export function llmsText() {
  const lines = [
    "# 0g.hk",
    "",
    "Minimal, no-login short URL + text note service on " + BASE_HOST + ".",
    "",
    "API version: " + API_VERSION,
    "",
    "## One-shot: create",
    "",
    "curl -X POST https://" + BASE_HOST + "/ \\",
    "  -H 'content-type: application/json' \\",
    "  -d '{\"content\":\"https://example.com\",\"name\":\"demo\",\"ttl\":\"7d\"}'",
    "",
    "# or simplest:",
    "curl 'https://" + BASE_HOST + "/?c=hello-world'",
    "",
    "## Read",
    "",
    "curl https://<name>." + BASE_HOST + "/       # HTML or 302 redirect",
    "curl https://<name>." + BASE_HOST + "/raw    # raw body",
    "curl -H 'accept: application/json' https://<name>." + BASE_HOST + "/",
    "",
    "## Edit (needs editToken from create)",
    "",
    "curl -X POST https://<name>." + BASE_HOST + "/ \\",
    "  -H 'content-type: application/json' \\",
    "  -d '{\"content\":\"new-content\",\"token\":\"<editToken>\"}'",
    "",
    "## Limits",
    "",
    "- name: [a-z0-9-]{2,32}, alnum ends",
    "- text: " + TEXT_MAX + " bytes, url: " + URL_MAX + " bytes",
    "- ttl: " + Object.keys(TTL_OPTIONS).join(" / ") + " (default " + DEFAULT_TTL + ")",
    "- rate: " + RATE_LIMIT + " req/min/ip (may adapt down after repeat rejections)",
    "- abuse: " + ABUSE_EMAIL,
  ];
  return lines.join("\n") + "\n";
}

export function llmsTextResponse() {
  return new Response(llmsText(), {
    status: 200,
    headers: {
      "content-type": "text/plain;charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
