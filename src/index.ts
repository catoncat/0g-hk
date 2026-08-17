// 0g.hk Worker — entry + core handlers (create/edit/subdomain/abuse/exists).
// Presentation, gates, storage, and admin are in sibling modules.
import { Hono } from "hono";
import { logger } from "hono/logger";
import { BASE_HOST, NAME_RE, RESERVED, TTL_OPTIONS, DEFAULT_TTL, RATE_LIMIT, API_VERSION, ABUSE_AUTO_DISABLE, ABUSE_EMAIL } from "./constants.js";
import { loadConfig } from "./config.js";
import { isBrandSquatting, isBlockedTargetHost, hasDangerousScheme, randomName, genToken, sha256Base64Url, ctEq, isUrl, resolveKind, readKind, normalizeUrl, parseUrlSafe, isAllowedTarget, rateLimit, recordReject, shortUrlFor, expiresAtIso, normalizeName, makeBackground, type Background } from "./util.js";
import { aiModerate, checkSafeBrowsing } from "./moderation.js";
import { html, jsonResponse, jsonError, replyError, wantsJson, isBrowserRequest, noteMetaHeaders, readBody, statusPage } from "./responses.js";
import { editorPage, resultPage, notePage, interstitialPage, editNotePage, notFoundPage } from "./views/index.js";
import { handleAdmin } from "./admin.js";

async function handleExists(env, url) {
  const n = normalizeName(url.searchParams.get("n"));
  if (!n) return jsonResponse({ valid: false, reason: "empty" });
  if (!NAME_RE.test(n)) return jsonResponse({ valid: false, reason: "invalid" });
  if (RESERVED.has(n)) return jsonResponse({ valid: false, reason: "reserved" });
  const brand = isBrandSquatting(n);
  if (brand) return jsonResponse({ valid: false, reason: "brand", term: brand });
  const existing = await env.NOTES.get("n:" + n);
  return jsonResponse({ valid: true, exists: existing !== null });
}

// `bg` is annotated deliberately: under `strict: false` every other parameter is
// implicitly `any`, so an explicit annotation on the new one is the only
// compiler-level check that every call site actually passes it.
async function handleCreate(req, env, url, bg: Background) {
  const bodyRes = await readBody(req);
  if (!bodyRes.ok) return replyError(req, url, "bad_body", bodyRes.err, 400);
  const bp = bodyRes.body || {};

  let name = normalizeName(bp.name || url.searchParams.get("n"));
  const rawContent = bp.content || url.searchParams.get("c") || "";
  if (!rawContent) {
    if (wantsJson(req, url)) return jsonError("missing_content", "content is required (body or ?c=)", 400);
    return editorPage();
  }

  // Write-time authority for the url-vs-text decision (D4). Everything below —
  // the length limit chosen, the gates run, the persisted `k`, the JSON `kind`
  // and the `x-kind` header — derives from this single value, so the branch
  // taken and the branch recorded cannot disagree.
  const kind = resolveKind(rawContent);
  const urlMode = kind === "url";
  const content = urlMode ? normalizeUrl(rawContent) : rawContent;
  const cfg = await loadConfig(env);
  if (urlMode && content.length > cfg.urlMax) return replyError(req, url, "url_too_long", "URL too long (max " + cfg.urlMax + ")", 413, { maxLength: cfg.urlMax });
  if (!urlMode && content.length > cfg.textMax) return replyError(req, url, "text_too_long", "Text too long (max " + cfg.textMax + ")", 413, { maxLength: cfg.textMax });
  if (urlMode && !parseUrlSafe(content)) return replyError(req, url, "malformed_url", "Malformed URL", 400);

  if (name) {
    if (!NAME_RE.test(name)) return replyError(req, url, "invalid_name", "Invalid name (小写字母/数字/-)", 400, { name });
    if (RESERVED.has(name)) return replyError(req, url, "reserved_name", "Reserved name", 400, { name });
  }

  const ttlKey = (bp.ttl || url.searchParams.get("ttl") || DEFAULT_TTL).toLowerCase();
  if (!(ttlKey in TTL_OPTIONS)) return replyError(req, url, "invalid_ttl", "Invalid ttl (use " + Object.keys(TTL_OPTIONS).join("/") + ")", 400, { allowed: Object.keys(TTL_OPTIONS) });
  const ttlSec = TTL_OPTIONS[ttlKey];

  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (!(await rateLimit(env, ip))) return replyError(req, url, "rate_limited", "Rate limit exceeded (" + RATE_LIMIT + "/min)", 429, { limit: RATE_LIMIT, windowSeconds: 60 });

  if (name) {
    const brand = isBrandSquatting(name);
    if (brand) { bg.waitUntil(recordReject(env, "brand_blocked", ip)); return replyError(req, url, "brand_blocked", "Name contains a restricted brand/phishing term (" + brand + ")", 400, { term: brand }); }
  }

  if (urlMode) {
    if (hasDangerousScheme(content)) { bg.waitUntil(recordReject(env, "bad_scheme", ip)); return replyError(req, url, "bad_scheme", "Dangerous URL scheme", 400); }
    const parsed = parseUrlSafe(content);
    if (parsed) {
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { bg.waitUntil(recordReject(env, "bad_scheme", ip)); return replyError(req, url, "bad_scheme", "Only http/https URLs are allowed", 400, { scheme: parsed.protocol }); }
      const blockedHost = isBlockedTargetHost(parsed.hostname);
      if (blockedHost) { bg.waitUntil(recordReject(env, "shortener_blocked", ip)); return replyError(req, url, "shortener_blocked", "Chaining URL shorteners is not allowed (" + blockedHost + ")", 400, { host: blockedHost }); }
    }
    const sb = await checkSafeBrowsing(env, content);
    if (!sb.ok && sb.threats) { bg.waitUntil(recordReject(env, "unsafe_target", ip)); return replyError(req, url, "unsafe_target", "Target URL flagged unsafe", 400, { threats: sb.threats }); }
  }

  const mod = await aiModerate(env, urlMode ? "url" : "text", content, name);
  if (!mod.ok) { bg.waitUntil(recordReject(env, "content_blocked", ip)); return replyError(req, url, "content_blocked", "Content classified as abusive by moderation", 400, { label: mod.label || "other", reason: mod.reason }); }

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
    return editorPage({ prefillContent: content, prefillName: name, prefillTtl: ttlKey, errorName: "“" + name + "” 已被占用，换一个名字。如是你本人创建的，请直接使用当时的编辑链接。" });
  }

  const token = genToken();
  const tokenHash = await sha256Base64Url(token);
  const createdAtMs = Date.now();
  const putOpts = ttlSec > 0 ? { expirationTtl: ttlSec } : {};
  // `v` stays 1: nothing in the codebase reads `meta.v`, and the feature
  // detection the read path needs is *presence of `k`* (see `readKind`), so a
  // version bump would add a predicate with no reader.
  const meta = JSON.stringify({ v: 1, h: tokenHash, t: ttlKey, ct: createdAtMs, k: kind });
  await Promise.all([
    env.NOTES.put(key, content, putOpts),
    env.NOTES.put("m:" + name, meta, putOpts),
  ]);

  const target = urlMode ? content.trim() : null;
  const mh = noteMetaHeaders({ name, ttlKey, createdAtMs, kind, target, editToken: token });

  if (wantsJson(req, url)) {
    return jsonResponse({ ok: true, apiVersion: API_VERSION, name, kind, shortUrl: shortUrlFor(name), rawUrl: shortUrlFor(name) + "/raw", editToken: token, editUrl: shortUrlFor(name) + "/edit#t=" + token, ttl: ttlKey, createdAt: new Date(createdAtMs).toISOString(), expiresAt: expiresAtIso(ttlKey, createdAtMs), target, contentLength: content.length }, 201, mh);
  }

  const r = resultPage(name, content, "created", ttlKey, token);
  for (const k in mh) r.headers.set(k, mh[k]);
  return r;
}

async function handleEdit(req, env, sub, url, bg: Background) {
  const bodyRes = await readBody(req);
  if (!bodyRes.ok) return replyError(req, url, "bad_body", bodyRes.err, 400);
  const bp = bodyRes.body || {};

  const token = bp.token || url.searchParams.get("edit") || "";
  let contentIn = bp.content || url.searchParams.get("c") || "";
  const renewFlag = bp.renew != null || url.searchParams.has("renew");
  if (!token) return replyError(req, url, "missing_token", "Missing edit token", 400);

  // Write-time authority, but only for a request that actually supplies content
  // (D4, 2.23). `kind` stays null here for a TTL-only / renew-only edit and is
  // filled in below from the STORED kind, so exactly one value drives the gates,
  // the persisted `k`, the JSON `kind` and the `x-kind` header (2.24).
  let kind = contentIn ? resolveKind(contentIn) : null;
  let urlMode = kind === "url";
  if (contentIn) {
    if (urlMode) contentIn = normalizeUrl(contentIn);
    const cfg = await loadConfig(env);
    if (urlMode && contentIn.length > cfg.urlMax) return replyError(req, url, "url_too_long", "URL too long", 413, { maxLength: cfg.urlMax });
    if (!urlMode && contentIn.length > cfg.textMax) return replyError(req, url, "text_too_long", "Text too long", 413, { maxLength: cfg.textMax });
    if (urlMode && !parseUrlSafe(contentIn)) return replyError(req, url, "malformed_url", "Malformed URL", 400);
  }

  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (!(await rateLimit(env, ip))) return replyError(req, url, "rate_limited", "Rate limit exceeded (" + RATE_LIMIT + "/min)", 429, { limit: RATE_LIMIT, windowSeconds: 60 });

  const metaRawOrig = await env.NOTES.get("m:" + sub);
  if (!metaRawOrig) return replyError(req, url, "not_editable", "Not editable", 403);
  // Parsed ONCE (the `ct` comparison used to re-parse the same bytes further
  // down). `origMeta` holds what is stored, `meta` is the mutable copy that gets
  // written back, so the rewrite guard below can compare the two field by field.
  let origMeta;
  try { origMeta = JSON.parse(metaRawOrig); } catch { return replyError(req, url, "corrupt_meta", "Corrupt meta", 500); }
  const tokenHash = await sha256Base64Url(token);
  if (!ctEq(tokenHash, origMeta.h || "")) return replyError(req, url, "invalid_token", "Invalid edit token", 403);
  const meta = { ...origMeta };

  let content = contentIn;
  if (content) {
    // An explicit content rewrite is the ONLY way a note's kind changes, and it
    // is now recorded instead of re-derived on every read (2.23).
    meta.k = kind;
  } else {
    const existing = await env.NOTES.get("n:" + sub);
    if (existing == null) return replyError(req, url, "not_found", "Not found", 404);
    content = existing;
    // TTL-only / renew-only edit: report the STORED kind (with the legacy
    // isUrl fallback for records written before `k` existed) and leave `meta.k`
    // exactly as it was, including absent (2.22). Backfilling it here was
    // considered and rejected in design.md — the value would equal the fallback
    // anyway, but `k` would then change during an operation that supplies no
    // content, and the 7-day maximum TTL already bounds the fallback window.
    kind = readKind(origMeta, content);
    urlMode = kind === "url";
  }

  if (contentIn) {
    if (urlMode) {
      if (hasDangerousScheme(content)) { bg.waitUntil(recordReject(env, "bad_scheme", ip)); return replyError(req, url, "bad_scheme", "Dangerous URL scheme", 400); }
      const parsed = parseUrlSafe(content);
      if (parsed) {
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { bg.waitUntil(recordReject(env, "bad_scheme", ip)); return replyError(req, url, "bad_scheme", "Only http/https URLs are allowed", 400, { scheme: parsed.protocol }); }
        const blockedHost = isBlockedTargetHost(parsed.hostname);
        if (blockedHost) { bg.waitUntil(recordReject(env, "shortener_blocked", ip)); return replyError(req, url, "shortener_blocked", "Chaining URL shorteners is not allowed", 400, { host: blockedHost }); }
      }
      const sb = await checkSafeBrowsing(env, content);
      if (!sb.ok && sb.threats) { bg.waitUntil(recordReject(env, "unsafe_target", ip)); return replyError(req, url, "unsafe_target", "Target URL flagged unsafe", 400, { threats: sb.threats }); }
    }
    const mod = await aiModerate(env, urlMode ? "url" : "text", content, sub);
    if (!mod.ok) { bg.waitUntil(recordReject(env, "content_blocked", ip)); return replyError(req, url, "content_blocked", "Content classified as abusive by moderation", 400, { label: mod.label || "other", reason: mod.reason }); }
  }

  const newTtlRaw = (bp.ttl || url.searchParams.get("ttl") || "").toLowerCase();
  if (newTtlRaw && !(newTtlRaw in TTL_OPTIONS)) return replyError(req, url, "invalid_ttl", "Invalid ttl (use " + Object.keys(TTL_OPTIONS).join("/") + ")", 400, { allowed: Object.keys(TTL_OPTIONS) });
  const ttlKey = newTtlRaw || (TTL_OPTIONS[origMeta.t] !== undefined ? origMeta.t : DEFAULT_TTL);
  meta.t = ttlKey;
  meta.ct = meta.ct || Date.now();
  if (renewFlag || newTtlRaw || contentIn) meta.ct = Date.now();
  // Reuse the original bytes only when nothing we persist actually moved. `k`
  // joins the comparison so a newly-recorded kind is never dropped by this path.
  const metaRaw = (ttlKey !== origMeta.t || meta.ct !== origMeta.ct || meta.k !== origMeta.k) ? JSON.stringify(meta) : metaRawOrig;

  const ttlSec = TTL_OPTIONS[ttlKey];
  const putOpts = ttlSec > 0 ? { expirationTtl: ttlSec } : {};
  await Promise.all([
    env.NOTES.put("n:" + sub, content, putOpts),
    env.NOTES.put("m:" + sub, metaRaw, putOpts),
  ]);

  const target = urlMode ? content.trim() : null;
  const createdAtMs = meta.ct || Date.now();
  const mh = noteMetaHeaders({ name: sub, ttlKey, createdAtMs, kind, target });

  if (wantsJson(req, url)) {
    return jsonResponse({ ok: true, apiVersion: API_VERSION, name: sub, kind, shortUrl: shortUrlFor(sub), rawUrl: shortUrlFor(sub) + "/raw", ttl: ttlKey, createdAt: new Date(createdAtMs).toISOString(), expiresAt: expiresAtIso(ttlKey, createdAtMs), target, contentLength: content.length }, 200, mh);
  }

  const r = resultPage(sub, content, "updated", ttlKey, null);
  for (const k in mh) r.headers.set(k, mh[k]);
  return r;
}

async function handleAbuseReport(req, env, sub, url) {
  const ip = req.headers.get("cf-connecting-ip") || "0";
  const ipTrunc = ip.split(":").slice(0, 4).join(":").split(".").slice(0, 3).join(".");
  const day = new Date().toISOString().slice(0, 10);
  const dedupeKey = "abuse-dedupe:" + sub + ":" + day + ":" + (await sha256Base64Url(ipTrunc)).slice(0, 12);
  const counterKey = "abuse:" + sub;
  const [already, counterRaw] = await Promise.all([
    env.NOTES.get(dedupeKey),
    env.NOTES.get(counterKey),
  ]);
  let count = parseInt(counterRaw || "0", 10) || 0;
  let disabled = false;
  if (!already) {
    count += 1;
    const puts = [
      env.NOTES.put(counterKey, String(count), { expirationTtl: 30 * 86400 }),
      env.NOTES.put(dedupeKey, "1", { expirationTtl: 86400 }),
    ];
    if (count >= ABUSE_AUTO_DISABLE) {
      puts.push(env.NOTES.put("d:" + sub, JSON.stringify({ reason: "community_reports", count, at: Date.now() }), { expirationTtl: 365 * 86400 }));
      disabled = true;
    }
    await Promise.all(puts);
  }
  if (wantsJson(req, url)) return jsonResponse({ ok: true, name: sub, reports: count, disabled, deduped: !!already });
  return statusPage({
    title: "举报已提交",
    message: disabled ? "该链接已被自动禁用。" : ("累计举报：" + count + " 次。"),
    detailsHtml: '<p class="muted">感谢协助维护社区安全。</p>',
    tone: disabled ? "warn" : "ok",
    status: 200,
  });
}

async function handleSubdomain(req, env, host, url, bg: Background) {
  const pathname = url.pathname;
  const sub = host.slice(0, -(BASE_HOST.length + 1));
  if (!NAME_RE.test(sub) || RESERVED.has(sub)) {
    if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404, { name: sub });
    return notFoundPage(sub);
  }

  if (pathname === "/abuse/report") return handleAbuseReport(req, env, sub, url);

  const disabledRaw = await env.NOTES.get("d:" + sub);
  if (disabledRaw) {
    if (wantsJson(req, url)) return jsonError("disabled", "Content disabled due to abuse reports", 410, { name: sub });
    return statusPage({
      title: "内容已禁用",
      message: "该短链/笔记因举报被系统自动禁用。",
      detailsHtml: '<p class="muted">若系误判，请通过 <a href="mailto:' + ABUSE_EMAIL + '">' + ABUSE_EMAIL + "</a> 申诉。</p>",
      tone: "warn",
      status: 410,
    });
  }

  if (url.searchParams.has("edit") || req.method === "POST" || req.method === "PUT") return handleEdit(req, env, sub, url, bg);

  if (pathname === "/edit") {
    const [metaRaw, existing] = await Promise.all([
      env.NOTES.get("m:" + sub),
      env.NOTES.get("n:" + sub),
    ]);
    if (existing === null) {
      if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404, { name: sub });
      return notFoundPage(sub);
    }
    let meta: any = {};
    try { meta = metaRaw ? JSON.parse(metaRaw) : {}; } catch {}
    const ttlKey = TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL;
    return editNotePage(sub, ttlKey);
  }

  const [content, metaRaw] = await Promise.all([
    env.NOTES.get("n:" + sub),
    env.NOTES.get("m:" + sub),
  ]);
  if (content === null) {
    if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404, { name: sub });
    return notFoundPage(sub);
  }

  let meta: any = {};
  try { meta = metaRaw ? JSON.parse(metaRaw) : {}; } catch {}
  const ttlKey = TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL;
  const createdAtMs = meta.ct || 0;
  const urlMode = isUrl(content);
  const kind = urlMode ? "url" : "text";
  const target = urlMode ? content.trim() : null;
  const mh = noteMetaHeaders({ name: sub, ttlKey, createdAtMs, kind, target });

  if (pathname === "/raw") {
    return new Response(content, { headers: Object.assign({ "content-type": "text/plain;charset=utf-8", "cache-control": "public, max-age=60" }, mh) });
  }

  if (wantsJson(req, url)) {
    return jsonResponse({ ok: true, apiVersion: API_VERSION, name: sub, kind, shortUrl: shortUrlFor(sub), rawUrl: shortUrlFor(sub) + "/raw", content, target, ttl: ttlKey, createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null, expiresAt: expiresAtIso(ttlKey, createdAtMs), contentLength: content.length }, 200, mh);
  }

  if (urlMode) {
    const parsed = parseUrlSafe(content);
    if (!parsed) return notePage(sub, content);
    if (isAllowedTarget(target)) {
      return new Response(null, { status: 302, headers: Object.assign({ location: target }, mh) });
    }
    return interstitialPage(sub, target);
  }
  return notePage(sub, content);
}

function corsPreflight() {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, OPTIONS", "access-control-allow-headers": "content-type, accept, authorization", "access-control-max-age": "86400" } });
}

// --- Hono router (0X0-13) -------------------------------------------------
// Two apps: baseApp for the apex (0g.hk) and subApp for *.0g.hk. The outer
// fetch() does host-based dispatch + favicon + CORS preflight to preserve
// the exact behavior of the previous hand-rolled router.

const baseApp = new Hono<{ Bindings: Env }>();
const subApp = new Hono<{ Bindings: Env }>();

baseApp.use("*", logger());
subApp.use("*", logger());

const onError = (err: Error, c: any) => {
  console.error("unhandled", (err && err.stack) || err);
  const u = new URL(c.req.url);
  if (wantsJson(c.req.raw, u)) return jsonError("internal_error", "Internal error", 500);
  return new Response("Internal error", { status: 500 });
};
baseApp.onError(onError);
subApp.onError(onError);

// --- Background work plumbing (D2) ---------------------------------------
// hono's `c.executionCtx` getter THROWS ("This context has no
// ExecutionContext") when the context was built without one — it does not
// return undefined — so every access has to be guarded.
function safeExecutionCtx(c: any) {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

// The single choke point for every route that records telemetry: build the
// Background facade from whatever the platform gave us and settle it in a
// `finally`, so queued work is awaited even when the handler throws into
// onError. With a real ExecutionContext settle() is a no-op and the response is
// never delayed; without one the queued writes are awaited before returning.
async function withBackground(c: any, run: (bg: Background) => Promise<Response>): Promise<Response> {
  const bg = makeBackground(safeExecutionCtx(c));
  try {
    return await run(bg);
  } finally {
    await bg.settle();
  }
}

// --- Base host (0g.hk) ---
baseApp.get("/exists", (c) => handleExists(c.env, new URL(c.req.url)));
baseApp.all("/admin", (c) => handleAdmin(c.req.raw, c.env, new URL(c.req.url)));
baseApp.all("/admin/*", (c) => handleAdmin(c.req.raw, c.env, new URL(c.req.url)));
// /llms.txt, /llms-full.txt, /robots.txt, /favicon.svg are served from
// public/ via the [assets] binding before the Worker runs (see wrangler.toml).
baseApp.on(["POST", "PUT"], "/", (c) => withBackground(c, (bg) => handleCreate(c.req.raw, c.env, new URL(c.req.url), bg)));
baseApp.get("/", async (c) => {
  const u = new URL(c.req.url);
  if (u.searchParams.has("c")) return withBackground(c, (bg) => handleCreate(c.req.raw, c.env, u, bg));
  // Non-browser clients (curl/LLM agents) get the canonical short docs.
  if (!isBrowserRequest(c.req.raw)) return c.env.ASSETS.fetch(new URL("/llms.txt", c.req.url));
  return editorPage({
    prefillName: (u.searchParams.get("n") || "").toLowerCase().trim(),
    prefillContent: u.searchParams.get("c") || "",
  });
});
baseApp.notFound((c) => {
  const u = new URL(c.req.url);
  if (wantsJson(c.req.raw, u)) return jsonError("not_found", "Not found", 404);
  return new Response("Not found", { status: 404 });
});

// --- Subdomain (*.0g.hk) ---
// Subdomain handling has many interlocked branches (disabled/edit/raw/
// interstitial/JSON). Delegate to handleSubdomain to keep behavior identical;
// future issues can split it into per-route handlers.
subApp.all("*", (c) => {
  const u = new URL(c.req.url);
  const host = u.hostname.toLowerCase();
  return withBackground(c, (bg) => handleSubdomain(c.req.raw, c.env, host, u, bg));
});

export default {
  // `ctx` is annotated deliberately: under `strict: false` an explicit
  // annotation on the new parameter is the only compiler-level check that it is
  // accepted and forwarded. Forwarding it to app.fetch is what makes
  // `c.executionCtx` (and therefore waitUntil) usable at all.
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    if (req.method === "OPTIONS") return corsPreflight();
    if (host === BASE_HOST) return baseApp.fetch(req, env, ctx);
    if (host.endsWith("." + BASE_HOST)) return subApp.fetch(req, env, ctx);
    if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404);
    return new Response("Not found", { status: 404 });
  },
};
