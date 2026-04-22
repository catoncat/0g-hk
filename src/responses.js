// Response helpers: security headers, html/json responses, CSS theme, footer/promo, llms.txt,
// note-meta headers, and request body parsing.
import { BASE_HOST, API_VERSION, TTL_OPTIONS, TEXT_MAX, URL_MAX, RATE_LIMIT, DEFAULT_TTL, ABUSE_EMAIL } from "./constants.js";
import { shortUrlFor, expiresAtIso, esc } from "./util.js";

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
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px 22px;margin:0 0 16px}
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
.logo{font-family:var(--mono);font-size:1.1rem;font-weight:700;letter-spacing:-.02em;color:var(--text);text-decoration:none;line-height:1;flex:0 0 auto}.logo .dot{color:#10b981}.page-header{display:flex;justify-content:space-between;align-items:center;gap:.75rem;padding:0 0 .85rem;margin:0 0 1.25rem;border-bottom:1px solid var(--border)}.seg{display:inline-flex;border:1px solid var(--border-strong);border-radius:8px;overflow:hidden;flex:0 0 auto}.seg>*{padding:.5rem .85rem;min-height:36px;background:transparent;cursor:pointer;font-size:.82rem;color:inherit;font-family:inherit;border:0;text-decoration:none;display:inline-flex;align-items:center;-webkit-tap-highlight-color:transparent}.seg>*+*{border-left:1px solid var(--border-strong)}@media(hover:hover){.seg>*:hover{background:rgba(128,128,128,.12)}}.promo{display:block;margin:1.75rem 0 0;padding:1.1rem 1.25rem;border:1px solid var(--border);border-radius:12px;background:var(--surface);text-decoration:none;color:inherit;transition:border-color .15s,background .15s}@media(hover:hover){.promo:hover{border-color:var(--border-strong);background:var(--surface-2)}.promo:hover .promo-cta{transform:translateX(2px)}}.promo-t{display:block;font-size:1rem;font-weight:600;letter-spacing:-.01em;margin-bottom:.3rem}.promo-t .promo-dot{color:#10b981}.promo-s{display:block;font-size:.82rem;color:var(--muted);line-height:1.5}.promo-s code{font-family:var(--mono);font-size:.88em;background:rgba(128,128,128,.1);padding:.05rem .3rem;border-radius:3px}.promo-cta{display:inline-block;margin-top:.7rem;font-size:.85rem;font-weight:500;color:var(--text);transition:transform .15s}@media (max-width:560px){body{padding:12px 10px}.card{padding:16px 14px;border-radius:12px}h1{font-size:20px}}`;

export function footerHtml() {
  return '<div class="wrap" style="margin-top:24px"><p class="faint" style="text-align:center">' +
    '<a class="faint" href="https://' + BASE_HOST + '/" style="color:inherit">' + BASE_HOST + '</a> · ' +
    '<a class="faint" href="mailto:' + ABUSE_EMAIL + '" style="color:inherit">举报</a> · ' +
    '<a class="faint" href="https://' + BASE_HOST + '/llms.txt" style="color:inherit">llms.txt</a>' +
    '</p></div>';
}

export function headerHtml(rightSlot) {
  return '<header class="page-header"><a class="logo" href="https://' + BASE_HOST + '/">0g<span class="dot">.</span>hk</a>' + (rightSlot || '') + '</header>';
}

export function statusPage(opts) {
  opts = opts || {};
  const title = opts.title || "提示";
  const message = opts.message || "";
  const code = opts.code || "";
  const status = opts.status || 200;
  const tone = opts.tone || "info";
  const detailsHtml = opts.detailsHtml || "";
  const primaryHref = opts.primaryHref || ("https://" + BASE_HOST + "/");
  const primaryLabel = opts.primaryLabel || "返回首页";
  const secondaryHref = opts.secondaryHref || "";
  const secondaryLabel = opts.secondaryLabel || "";
  const toneClass = "tone-" + tone;
  const secondaryAction = (secondaryHref && secondaryLabel)
    ? '<a class="btn ghost" href="' + esc(secondaryHref) + '">' + esc(secondaryLabel) + '</a>'
    : "";
  const codeBlock = code
    ? '<p class="muted">错误码：<span class="mono">' + esc(code) + "</span></p>"
    : "";
  const body = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>' + esc(title) + " · " + BASE_HOST + '</title><style>' + COMMON_CSS +
    '.status-card{max-width:560px;margin:0 auto}.status-card h1{margin:0 0 .65rem;font-size:1.15rem}.status-card .lead{margin:0 0 .75rem;font-size:.95rem;line-height:1.6}.status-card .actions{display:flex;gap:.65rem;flex-wrap:wrap;margin-top:1rem}.status-card.tone-error{border-left:3px solid var(--err)}.status-card.tone-warn{border-left:3px solid var(--warn)}.status-card.tone-ok{border-left:3px solid var(--ok)}.status-card.tone-info{border-left:3px solid var(--border-strong)}.status-card .rich{margin:.75rem 0 0}.status-card .rich p:last-child{margin-bottom:0}' +
    '</style></head><body><div class="wrap">' + headerHtml() + '<div class="card status-card ' + toneClass + '">' +
    '<h1>' + esc(title) + "</h1>" +
    (message ? '<p class="lead">' + esc(message) + "</p>" : "") +
    (detailsHtml ? '<div class="rich">' + detailsHtml + "</div>" : "") +
    codeBlock +
    '<div class="actions"><a class="btn primary" href="' + esc(primaryHref) + '">' + esc(primaryLabel) + "</a>" + secondaryAction + "</div>" +
    "</div>" + footerHtml() + "</div></body></html>";
  return html(body, status);
}

export function promoCardHtml() {
  return '<a class="promo" href="https://' + BASE_HOST + '/">' +
    '<span class="promo-t">你也能用 0g<span class="promo-dot">.</span>hk 创建一个</span>' +
    '<span class="promo-s">复制一段文字 / 粘贴一条链接 → 生成 <code>xxx.' + BASE_HOST + '</code>，7 天后自毁</span>' +
    '<span class="promo-cta">试试 →</span>' +
    '</a>';
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
  return statusPage({
    status,
    tone: "error",
    title: "失败了",
    message,
    code,
  });
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
