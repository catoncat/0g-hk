// 0g.hk Worker — entry + core handlers (create/edit/subdomain/abuse/exists).
// Presentation, gates, storage, and admin are in sibling modules.
import { BASE_HOST, NAME_RE, RESERVED, TTL_OPTIONS, DEFAULT_TTL, TEXT_MAX, URL_MAX, RATE_LIMIT, API_VERSION, ABUSE_AUTO_DISABLE, ABUSE_EMAIL } from "./constants.js";
import { isBrandSquatting, isBlockedTargetHost, hasDangerousScheme, randomName, genToken, sha256Base64Url, ctEq, isUrl, normalizeUrl, parseUrlSafe, isAllowedTarget, rateLimit, recordReject, shortUrlFor, expiresAtIso, normalizeName } from "./util.js";
import { aiModerate, checkSafeBrowsing } from "./moderation.js";
import { html, jsonResponse, jsonError, replyError, wantsJson, isBrowserRequest, noteMetaHeaders, readBody, llmsTextResponse, statusPage } from "./responses.js";
import { editorPage, resultPage, notePage, interstitialPage, editNotePage, notFoundPage } from "./pages.js";
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

async function handleCreate(req, env, url) {
  const bodyRes = await readBody(req);
  if (!bodyRes.ok) return replyError(req, url, "bad_body", bodyRes.err, 400);
  const bp = bodyRes.body || {};

  let name = normalizeName(bp.name || url.searchParams.get("n"));
  const rawContent = bp.content || url.searchParams.get("c") || "";
  if (!rawContent) {
    if (wantsJson(req, url)) return jsonError("missing_content", "content is required (body or ?c=)", 400);
    return editorPage();
  }

  const urlMode = isUrl(rawContent);
  const content = urlMode ? normalizeUrl(rawContent) : rawContent;
  if (urlMode && content.length > URL_MAX) return replyError(req, url, "url_too_long", "URL too long (max " + URL_MAX + ")", 413, { maxLength: URL_MAX });
  if (!urlMode && content.length > TEXT_MAX) return replyError(req, url, "text_too_long", "Text too long (max " + TEXT_MAX + ")", 413, { maxLength: TEXT_MAX });
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
    if (brand) { recordReject(env, "brand_blocked", ip); return replyError(req, url, "brand_blocked", "Name contains a restricted brand/phishing term (" + brand + ")", 400, { term: brand }); }
  }

  if (urlMode) {
    if (hasDangerousScheme(content)) { recordReject(env, "bad_scheme", ip); return replyError(req, url, "bad_scheme", "Dangerous URL scheme", 400); }
    const parsed = parseUrlSafe(content);
    if (parsed) {
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { recordReject(env, "bad_scheme", ip); return replyError(req, url, "bad_scheme", "Only http/https URLs are allowed", 400, { scheme: parsed.protocol }); }
      const blockedHost = isBlockedTargetHost(parsed.hostname);
      if (blockedHost) { recordReject(env, "shortener_blocked", ip); return replyError(req, url, "shortener_blocked", "Chaining URL shorteners is not allowed (" + blockedHost + ")", 400, { host: blockedHost }); }
    }
    const sb = await checkSafeBrowsing(env, content);
    if (!sb.ok && sb.threats) { recordReject(env, "unsafe_target", ip); return replyError(req, url, "unsafe_target", "Target URL flagged unsafe", 400, { threats: sb.threats }); }
  }

  const mod = await aiModerate(env, urlMode ? "url" : "text", content, name);
  if (!mod.ok) { recordReject(env, "content_blocked", ip); return replyError(req, url, "content_blocked", "Content classified as abusive by moderation", 400, { label: mod.label || "other", reason: mod.reason }); }

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
  const meta = JSON.stringify({ v: 1, h: tokenHash, t: ttlKey, ct: createdAtMs });
  await env.NOTES.put(key, content, putOpts);
  await env.NOTES.put("m:" + name, meta, putOpts);

  const kind = urlMode ? "url" : "text";
  const target = urlMode ? content.trim() : null;
  const mh = noteMetaHeaders({ name, ttlKey, createdAtMs, kind, target, editToken: token });

  if (wantsJson(req, url)) {
    return jsonResponse({ ok: true, apiVersion: API_VERSION, name, kind, shortUrl: shortUrlFor(name), rawUrl: shortUrlFor(name) + "/raw", editToken: token, editUrl: shortUrlFor(name) + "/edit#t=" + token, ttl: ttlKey, createdAt: new Date(createdAtMs).toISOString(), expiresAt: expiresAtIso(ttlKey, createdAtMs), target, contentLength: content.length }, 201, mh);
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

  let urlMode = false;
  if (contentIn) {
    urlMode = isUrl(contentIn);
    if (urlMode) contentIn = normalizeUrl(contentIn);
    if (urlMode && contentIn.length > URL_MAX) return replyError(req, url, "url_too_long", "URL too long", 413, { maxLength: URL_MAX });
    if (!urlMode && contentIn.length > TEXT_MAX) return replyError(req, url, "text_too_long", "Text too long", 413, { maxLength: TEXT_MAX });
    if (urlMode && !parseUrlSafe(contentIn)) return replyError(req, url, "malformed_url", "Malformed URL", 400);
  }

  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (!(await rateLimit(env, ip))) return replyError(req, url, "rate_limited", "Rate limit exceeded (" + RATE_LIMIT + "/min)", 429, { limit: RATE_LIMIT, windowSeconds: 60 });

  const metaRawOrig = await env.NOTES.get("m:" + sub);
  if (!metaRawOrig) return replyError(req, url, "not_editable", "Not editable", 403);
  let meta;
  try { meta = JSON.parse(metaRawOrig); } catch { return replyError(req, url, "corrupt_meta", "Corrupt meta", 500); }
  const tokenHash = await sha256Base64Url(token);
  if (!ctEq(tokenHash, meta.h || "")) return replyError(req, url, "invalid_token", "Invalid edit token", 403);

  let content = contentIn;
  if (!content) {
    const existing = await env.NOTES.get("n:" + sub);
    if (existing == null) return replyError(req, url, "not_found", "Not found", 404);
    content = existing;
    urlMode = isUrl(content);
  }

  if (contentIn) {
    if (urlMode) {
      if (hasDangerousScheme(content)) { recordReject(env, "bad_scheme", ip); return replyError(req, url, "bad_scheme", "Dangerous URL scheme", 400); }
      const parsed = parseUrlSafe(content);
      if (parsed) {
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { recordReject(env, "bad_scheme", ip); return replyError(req, url, "bad_scheme", "Only http/https URLs are allowed", 400, { scheme: parsed.protocol }); }
        const blockedHost = isBlockedTargetHost(parsed.hostname);
        if (blockedHost) { recordReject(env, "shortener_blocked", ip); return replyError(req, url, "shortener_blocked", "Chaining URL shorteners is not allowed", 400, { host: blockedHost }); }
      }
      const sb = await checkSafeBrowsing(env, content);
      if (!sb.ok && sb.threats) { recordReject(env, "unsafe_target", ip); return replyError(req, url, "unsafe_target", "Target URL flagged unsafe", 400, { threats: sb.threats }); }
    }
    const mod = await aiModerate(env, urlMode ? "url" : "text", content, sub);
    if (!mod.ok) { recordReject(env, "content_blocked", ip); return replyError(req, url, "content_blocked", "Content classified as abusive by moderation", 400, { label: mod.label || "other", reason: mod.reason }); }
  }

  const newTtlRaw = (bp.ttl || url.searchParams.get("ttl") || "").toLowerCase();
  if (newTtlRaw && !(newTtlRaw in TTL_OPTIONS)) return replyError(req, url, "invalid_ttl", "Invalid ttl (use " + Object.keys(TTL_OPTIONS).join("/") + ")", 400, { allowed: Object.keys(TTL_OPTIONS) });
  const ttlKey = newTtlRaw || (TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL);
  const origTtl = meta.t;
  meta.t = ttlKey;
  meta.ct = meta.ct || Date.now();
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
  const already = await env.NOTES.get(dedupeKey);
  const counterKey = "abuse:" + sub;
  let count = parseInt((await env.NOTES.get(counterKey)) || "0", 10) || 0;
  let disabled = false;
  if (!already) {
    count += 1;
    await env.NOTES.put(counterKey, String(count), { expirationTtl: 30 * 86400 });
    await env.NOTES.put(dedupeKey, "1", { expirationTtl: 86400 });
    if (count >= ABUSE_AUTO_DISABLE) {
      await env.NOTES.put("d:" + sub, JSON.stringify({ reason: "community_reports", count, at: Date.now() }), { expirationTtl: 365 * 86400 });
      disabled = true;
    }
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

async function handleSubdomain(req, env, host, url) {
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

  if (url.searchParams.has("edit") || req.method === "POST" || req.method === "PUT") return handleEdit(req, env, sub, url);

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
    return new Response(content, { headers: Object.assign({ "content-type": "text/plain;charset=utf-8", "cache-control": "public, max-age=60" }, mh) });
  }

  if (wantsJson(req, url)) {
    return jsonResponse({ ok: true, apiVersion: API_VERSION, name: sub, kind, shortUrl: shortUrlFor(sub), rawUrl: shortUrlFor(sub) + "/raw", content, target, ttl: ttlKey, createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null, expiresAt: expiresAtIso(ttlKey, createdAtMs), contentLength: content.length }, 200, mh);
  }

  if (urlMode) {
    const parsed = parseUrlSafe(content);
    if (!parsed) return notePage(sub, content);
    const bypass = url.searchParams.get("go") === "1";
    if (bypass || isAllowedTarget(target)) {
      return new Response(null, { status: 302, headers: Object.assign({ location: target }, mh) });
    }
    return interstitialPage(sub, target);
  }
  return notePage(sub, content);
}

function corsPreflight() {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, OPTIONS", "access-control-allow-headers": "content-type, accept, authorization", "access-control-max-age": "86400" } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    if (req.method === "OPTIONS") return corsPreflight();

    if (host === BASE_HOST) {
      if (url.pathname === "/exists") return handleExists(env, url);
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(req, env, url);
      if (url.pathname === "/llms.txt" || (url.pathname === "/robots.txt" && url.searchParams.has("llms"))) return llmsTextResponse();
      if (url.pathname === "/" || url.pathname === "") {
        if (req.method === "POST" || req.method === "PUT" || url.searchParams.has("c")) return handleCreate(req, env, url);
        if (req.method === "GET" && !isBrowserRequest(req)) return llmsTextResponse();
        return editorPage({ prefillName: (url.searchParams.get("n") || "").toLowerCase().trim(), prefillContent: url.searchParams.get("c") || "" });
      }
      if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404);
      return new Response("Not found", { status: 404 });
    }
    if (host.endsWith("." + BASE_HOST)) return handleSubdomain(req, env, host, url);

    if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404);
    return new Response("Not found", { status: 404 });
  },
};
