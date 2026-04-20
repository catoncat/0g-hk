// Abuse gates: Workers AI LlamaGuard moderation + Google Safe Browsing + Turnstile.
import { sha256Base64Url } from "./util.js";

// AI moderation via Workers AI (LlamaGuard). Fails open on outage.
// Cached 24h by (kind,hash) so repeat content is free.
export async function aiModerate(env, kind, content, name) {
  if (!env || !env.AI || typeof env.AI.run !== "function") return { ok: true };
  try {
    const payload = (name ? "[name:" + name + "] " : "") + "[" + kind + "] " + String(content || "").slice(0, 4000);
    const h = (await sha256Base64Url(payload)).slice(0, 32);
    const cacheKey = "aimod:" + kind + ":" + h;
    const cached = await env.NOTES.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }
    const resp = await env.AI.run("@cf/meta/llama-guard-3-8b", {
      messages: [{ role: "user", content: payload }],
    });
    const raw = typeof resp === "string" ? resp : (resp && resp.response) || "";
    const text = String(raw).toLowerCase();
    let ok = true, label = null, reason = null;
    if (text.includes("unsafe")) {
      ok = false;
      const m = text.match(/s\d+/);
      label = m ? m[0] : "unsafe";
      reason = "llamaguard:" + label;
    }
    const res = { ok, label, reason };
    await env.NOTES.put(cacheKey, JSON.stringify(res), { expirationTtl: 24 * 3600 });
    return res;
  } catch (e) {
    return { ok: true, reason: "ai-error:" + String(e && e.message || e).slice(0, 80) };
  }
}

// Google Safe Browsing lookup. No-op if SAFE_BROWSING_KEY unset.
export async function checkSafeBrowsing(env, url) {
  const key = env && env.SAFE_BROWSING_KEY;
  if (!key) return { ok: true };
  try {
    const body = {
      client: { clientId: "0g-hk", clientVersion: "1.0" },
      threatInfo: {
        threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
        platformTypes: ["ANY_PLATFORM"],
        threatEntryTypes: ["URL"],
        threatEntries: [{ url }],
      },
    };
    const r = await fetch("https://safebrowsing.googleapis.com/v4/threatMatches:find?key=" + encodeURIComponent(key), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: true, reason: "sb-http-" + r.status };
    const j = await r.json();
    const matches = Array.isArray(j.matches) ? j.matches : [];
    if (matches.length === 0) return { ok: true };
    return { ok: false, threats: matches.map((m) => m.threatType).filter(Boolean) };
  } catch (e) {
    return { ok: true, reason: "sb-error:" + String(e && e.message || e).slice(0, 80) };
  }
}

// Cloudflare Turnstile server-side verification. No-op if TURNSTILE_SECRET unset.
export async function verifyTurnstile(env, token, ip) {
  const secret = env && env.TURNSTILE_SECRET;
  if (!secret) return { ok: true };
  if (!token) return { ok: false, reason: "missing" };
  try {
    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const j = await r.json();
    return { ok: !!j.success, reason: j["error-codes"] && j["error-codes"].join(",") };
  } catch (e) {
    return { ok: true, reason: "ts-error:" + String(e && e.message || e).slice(0, 80) };
  }
}
