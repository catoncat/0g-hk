// Runtime-tunable configuration. Persisted as a single JSON blob in KV under `cfg:v1`.
// To add a new control item:
//   1. Append a row to CONFIG_SCHEMA (key + label + type + bounds + default).
//   2. Read it via loadConfig(env) wherever you need it.
//   3. The /admin/config UI picks up new rows automatically.

import { TEXT_MAX, URL_MAX, RATE_LIMIT } from "./constants.js";

export const CFG_KEY = "cfg:v1";

// Schema drives both validation and the admin UI. Keep entries small and explicit.
export const CONFIG_SCHEMA = [
  {
    key: "textMax",
    label: "笔记正文上限 (bytes)",
    help: "单条纯文本笔记允许的最大字节数。URL 短链不受这条限制。",
    type: "int",
    min: 1024,
    max: 1024 * 1024,
    default: TEXT_MAX,
  },
  {
    key: "urlMax",
    label: "URL 长度上限 (bytes)",
    help: "短链原始 URL 允许的最大字节数。",
    type: "int",
    min: 64,
    max: 8192,
    default: URL_MAX,
  },
  {
    key: "rateLimit",
    label: "速率上限 (次/分钟/IP)",
    help: "create / edit 接口在 60 秒窗口内对单 IP 允许的最大请求次数。展示用，限流逻辑暂沿用常量。",
    type: "int",
    min: 1,
    max: 1000,
    default: RATE_LIMIT,
    readOnly: true,
  },
];

export const CONFIG_DEFAULTS = Object.fromEntries(
  CONFIG_SCHEMA.map((s) => [s.key, s.default]),
);

function coerceValue(s, raw) {
  if (raw == null || raw === "") return null;
  if (s.type === "int") {
    const n = typeof raw === "number" ? raw : parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (s.type === "string") return String(raw);
  if (s.type === "bool") return raw === true || raw === "1" || raw === "true" || raw === "on";
  return null;
}

function validate(s, v) {
  if (s.type === "int") {
    if (typeof s.min === "number" && v < s.min) return "必须 ≥ " + s.min;
    if (typeof s.max === "number" && v > s.max) return "必须 ≤ " + s.max;
  }
  return null;
}

// Load merged config (defaults + KV overrides). Always returns a fully-populated object.
export async function loadConfig(env) {
  const out = { ...CONFIG_DEFAULTS };
  try {
    const raw = env && env.NOTES ? await env.NOTES.get(CFG_KEY) : null;
    if (raw) {
      const stored = JSON.parse(raw);
      for (const s of CONFIG_SCHEMA) {
        if (Object.prototype.hasOwnProperty.call(stored, s.key)) {
          const v = coerceValue(s, stored[s.key]);
          if (v != null && !validate(s, v)) out[s.key] = v;
        }
      }
    }
  } catch {}
  return out;
}

// Save partial config; missing keys keep their current value. Stores only diffs vs default.
export async function saveConfig(env, partial) {
  const current = await loadConfig(env);
  const next = { ...current };
  const errors = {};
  for (const s of CONFIG_SCHEMA) {
    if (s.readOnly) continue;
    if (!Object.prototype.hasOwnProperty.call(partial, s.key)) continue;
    const coerced = coerceValue(s, partial[s.key]);
    if (coerced == null) { errors[s.key] = "非法值"; continue; }
    const err = validate(s, coerced);
    if (err) { errors[s.key] = err; continue; }
    next[s.key] = coerced;
  }
  if (Object.keys(errors).length) return { ok: false, errors, config: current };
  const overrides = {};
  for (const s of CONFIG_SCHEMA) {
    if (next[s.key] !== s.default) overrides[s.key] = next[s.key];
  }
  if (Object.keys(overrides).length === 0) await env.NOTES.delete(CFG_KEY);
  else await env.NOTES.put(CFG_KEY, JSON.stringify(overrides));
  return { ok: true, config: next, overrides };
}
