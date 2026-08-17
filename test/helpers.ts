// Shared test harness for the write-path-security-hardening spec.
//
// Four primitives, each required by design.md's *Validation Approach*:
//
//   captureLogs()               — console spy over log/error/warn/info.
//   expectRedactedLogPresent()  — the NON-VACUITY guard for "no token in logs".
//   nextIp()                    — a distinct cf-connecting-ip per request.
//   observe(res, env, name)     — the preservation tuple design.md defines.
//
// These are consumed by test/preservation.test.ts (task 1) and by the
// exploratory / fix-checking suites in later tasks.
import { SELF } from "cloudflare:test";
import { vi, expect } from "vitest";

// ---------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------

export interface LogCapture {
  /** Every captured line, in emission order. Mutated as logs arrive. */
  lines: string[];
  /** Joined view, for substring assertions over the whole transcript. */
  text(): string;
  restore(): void;
}

function fmtArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return String(a.stack || a.message);
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/**
 * Spy on console.log AND error/warn/info, joining every captured argument into
 * one line per call. error/warn/info are included deliberately: a stray
 * console.error carrying a secret would otherwise slip past a log-only spy.
 *
 * Output is swallowed while the spies are installed; call restore() in a
 * finally block (or afterEach) so a failing assertion cannot silence the rest
 * of the run.
 */
export function captureLogs(): LogCapture {
  const lines: string[] = [];
  const methods = ["log", "error", "warn", "info"] as const;
  const spies = methods.map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(fmtArg).join(" "));
    }),
  );
  return {
    lines,
    text: () => lines.join("\n"),
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}

/** The shape redactLogLine (task 6.2) leaves behind: parameter name kept, value gone. */
export const REDACTED_MARKER = "edit=[redacted]";

/**
 * NON-VACUITY GUARD.
 *
 * "No captured line contains the token" passes trivially when no line was
 * captured at all — a broken spy, a renamed logger, or a request that never
 * reached the router all produce the same green tick. Any test making that
 * claim must ALSO assert that a line was emitted *and* redacted.
 *
 * NOTE (task 1): the unfixed code redacts nothing, so this guard is written
 * here but is only assertable once task 6.3 lands. Task 1 exercises it against
 * synthetic input only (see test/helpers.test.ts).
 */
export function expectRedactedLogPresent(lines: string[]): void {
  const hit = lines.some((l) => l.includes(REDACTED_MARKER));
  expect(
    hit,
    `non-vacuity guard: expected some captured log line to contain "${REDACTED_MARKER}", ` +
      `but none of the ${lines.length} captured line(s) did. ` +
      `Without this, "the token is absent from the logs" passes even when nothing was logged.`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// Observing the Worker's OWN log lines (added in task 2)
// ---------------------------------------------------------------------------
//
// captureLogs() above spies on the console of the TEST isolate. That is not
// enough to observe hono's logger(), for two independent reasons discovered by
// direct experiment in task 2:
//
//  1. `SELF.fetch` dispatches to the Worker under test in a SEPARATE isolate,
//     so a spy installed in the test isolate never sees its console at all.
//  2. hono's `logger(fn = console.log)` binds `console.log` as a DEFAULT
//     PARAMETER, evaluated when `logger()` is called — i.e. while src/index.ts
//     is being evaluated, which the pool does at isolate boot, before any test
//     module body runs. Even in one isolate, a spy installed later is invisible.
//
// The fix is to obtain a SECOND, freshly-evaluated instance of the Worker entry
// module in the test isolate, with a console.log trampoline already installed so
// that `logger()` binds an indirection that re-reads `console.log` on every
// call. A later `vi.spyOn(console, "log")` is then observed normally.
//
// `?logspy=1` makes the module id distinct so the bundler re-evaluates
// src/index.ts (its imports stay cached). `vi.resetModules()` was tried first
// and rejected: it tears down the pool's own worker instance and every
// subsequent SELF.fetch answers 500.
//
// The returned fetcher shares `env` with SELF, so KV state seeded through
// SELF.fetch is visible to it and vice versa.

export interface WorkerModule {
  fetch(req: Request, env: any, ctx?: any): Promise<Response>;
}

let trampolineInstalled = false;
let logCaptureWorker: Promise<WorkerModule> | null = null;

function installLogTrampoline(): void {
  if (trampolineInstalled) return;
  trampolineInstalled = true;
  const boundReal = console.log.bind(console);
  const trampoline = (...args: unknown[]): void => {
    // No spy installed -> behave exactly like console.log.
    // Spy installed  -> route through it, so captureLogs() sees the line.
    if (console.log === (trampoline as any)) boundReal(...args);
    else (console.log as any)(...args);
  };
  console.log = trampoline as any;
}

/**
 * A Worker fetcher whose hono logger() output is visible to captureLogs().
 *
 * Use this INSTEAD of SELF.fetch for the one request whose log line is under
 * assertion; use SELF.fetch for everything else (seeding, reading back), since
 * both share `env`.
 */
export function workerWithLogCapture(): Promise<WorkerModule> {
  if (!logCaptureWorker) {
    installLogTrampoline();
    logCaptureWorker = import("../src/index.js?logspy=1").then((m: any) => m.default as WorkerModule);
  }
  return logCaptureWorker;
}

// ---------------------------------------------------------------------------
// Per-request client addresses
// ---------------------------------------------------------------------------

let ipCounter = 0;

/**
 * Mint a distinct cf-connecting-ip, to be sent on EVERY request of a sequence.
 *
 * rateLimit() falls back to ip = "0" when the header is absent, so header-less
 * requests share one `rl:0:<minute>` bucket and one `rej-ip:0` counter and
 * cross-contaminate every rate-limit / rejection-count assertion.
 *
 * The third octet advances as well as the fourth, so callers that need many
 * distinct rate-limit buckets get them (the bucket key is the full address
 * string). CAVEAT: consecutive addresses may share a /24, which is irrelevant
 * to rate limiting but load-bearing for the D3 reporter-group tests — those
 * must choose their own addresses rather than use nextIp().
 */
export function nextIp(): string {
  const n = ipCounter++;
  const third = 100 + (Math.floor(n / 254) % 100);
  const fourth = 1 + (n % 254);
  return `198.51.${third}.${fourth}`;
}

/** Test-only: reset the address counter (keeps fixtures stable across runs). */
export function resetIpCounter(): void {
  ipCounter = 0;
}

// ---------------------------------------------------------------------------
// The preservation tuple
// ---------------------------------------------------------------------------

export interface ObserveOptions {
  /** Also record these raw KV keys (e.g. "d:foo", "abuse:foo"). */
  extraKeys?: string[];
  /** A secret whose *locations* (never its value) are recorded. */
  token?: string;
  /** Replace this string with "<random>" everywhere (server-allocated names). */
  randomName?: string;
  /** Skip the /raw follow-up fetch (e.g. when the note does not exist). */
  skipRaw?: boolean;
  /**
   * For text/plain responses whose bytes are NOT owned by this spec (static
   * assets, which task 8 edits on purpose): record which markers are present
   * instead of the bytes, so a documentation edit is not a false regression.
   */
  textMarkers?: string[];
}

/** Stable markers used to identify which HTML branch answered. */
const HTML_MARKERS: Array<[string, string]> = [
  ["interstitial-warning", "即将离开"],
  ["interstitial-report", "举报此链接"],
  ["not-found-page", "还没人占用"],
  ["disabled-page", "该短链/笔记因举报被系统自动禁用"],
  ["error-code-block", "错误码："],
  ["result-created", ">已创建<"],
  ["result-updated", ">已更新<"],
  ["editor-form", 'id="content"'],
  ["note-editor-textarea", 'id="c"'],
  ["abuse-report-submitted", "感谢协助维护社区安全"],
  ["turnstile-widget", "cf-turnstile"],
  ["admin-login-form", '/admin/login"'],
  ["admin-dashboard", "近 7 日拦截统计"],
];

const ISO_KEYS = new Set(["createdAt", "expiresAt", "disabledAt", "at", "until", "exp"]);
const TOKEN_KEYS = new Set(["editToken", "token"]);
const URL_WITH_TOKEN_KEYS = new Set(["editUrl"]);
const DAY_KEY_RE = /^\d{8}$/;

/**
 * Deep-normalize a parsed JSON body:
 *  - object keys are sorted, so KV/Promise.all completion order cannot churn
 *    the fixture;
 *  - volatile-by-nature values are replaced with a marker (see NORMALIZATION
 *    in test/__fixtures__/preservation-baseline.json for the rationale);
 *  - `rej:<yyyymmdd>:<code>` day maps are relabelled day0..dayN (newest first)
 *    and their counts blanked — those counts are exactly what D2 changes.
 */
function normalizeJson(value: any, keyPath: string[] = []): any {
  if (Array.isArray(value)) return value.map((v, i) => normalizeJson(v, keyPath.concat(String(i))));
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    const allDays = keys.length > 0 && keys.every((k) => DAY_KEY_RE.test(k));
    const out: Record<string, any> = {};
    if (allDays) {
      const sorted = keys.slice().sort().reverse();
      sorted.forEach((k, i) => {
        out["day" + i] = normalizeJson(value[k], keyPath.concat("day" + i));
      });
      return out;
    }
    for (const k of keys.slice().sort()) out[k] = normalizeJson(value[k], keyPath.concat(k));
    return out;
  }
  const key = keyPath[keyPath.length - 1] || "";
  const parent = keyPath.length >= 3 ? keyPath[keyPath.length - 3] : "";
  // rej counts under days.day<N>.<code>
  if (parent === "days" && typeof value === "number") return "<count>";
  if (TOKEN_KEYS.has(key) && typeof value === "string" && value) return "<token>";
  if (URL_WITH_TOKEN_KEYS.has(key) && typeof value === "string" && value) return "<url-with-token>";
  if (ISO_KEYS.has(key) && typeof value === "string" && value) return "<iso>";
  if (ISO_KEYS.has(key) && typeof value === "number") return "<ms>";
  return value;
}

/** m:<name> minus the volatile fields — and minus `k`, which task 5 adds. */
function normalizeMeta(raw: string | null): any {
  if (raw == null) return null;
  let meta: any;
  try {
    meta = JSON.parse(raw);
  } catch {
    return { unparseable: true, length: raw.length };
  }
  const out: Record<string, any> = {};
  for (const k of Object.keys(meta).sort()) {
    if (k === "k") continue; // excluded by design.md's tuple (task 5 adds it)
    if (k === "h") out[k] = "<token-hash>";
    else if (k === "ct") out[k] = "<ms>";
    else out[k] = meta[k];
  }
  return out;
}

function normalizeHeaderValue(name: string, value: string): string {
  if (name === "x-edit-token") return "<token>";
  if (name === "x-edit-url") return "<url-with-token>";
  if (name === "x-created-at") return "<iso>";
  if (name === "x-expires-at") return value === "never" ? "never" : "<iso>";
  if (name === "set-cookie") return value.replace(/=([^;]*)/, "=<value>");
  return value;
}

function htmlTitle(body: string): string | null {
  const m = body.match(/<title>([\s\S]*?)<\/title>/);
  return m ? m[1] : null;
}

function htmlMarkers(body: string): string[] {
  return HTML_MARKERS.filter(([, needle]) => body.includes(needle)).map(([id]) => id);
}

/** Where a secret's raw value appears in a response (never the value itself). */
function tokenLocations(token: string, res: Response, body: string, headers: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const [k, v] of Object.entries(headers)) if (v.includes(token)) hits.push("header." + k);
  for (const [k, v] of res.headers) if (v.includes(token) && !hits.includes("header." + k)) hits.push("header." + k);
  if (body.includes(token)) hits.push("body");
  return hits.sort();
}

/**
 * The observable tuple from design.md's *Preservation Checking*:
 * HTTP status, JSON error `code`, all `x-*` headers (sorted), `location` on a
 * redirect, `/raw` bytes, and `n:<name>` / `m:<name>` KV state excluding `k`.
 *
 * Consumes `res`. Pass the note name to also record /raw and KV state.
 */
export async function observe(res: Response, env: any, name: string | null, opts: ObserveOptions = {}): Promise<any> {
  const contentType = res.headers.get("content-type");
  const rawHeaders: Record<string, string> = {};
  for (const [k, v] of res.headers) {
    if (k.startsWith("x-") || k === "location" || k === "set-cookie" || k.startsWith("access-control-")) {
      rawHeaders[k] = normalizeHeaderValue(k, v);
    }
  }
  const headers: Record<string, string> = {};
  for (const k of Object.keys(rawHeaders).sort()) headers[k] = rawHeaders[k];

  const body = await res.text();
  const obs: Record<string, any> = {
    status: res.status,
    contentType,
    headers,
  };
  if (res.headers.get("location") != null) obs.location = res.headers.get("location");

  if ((contentType || "").includes("application/json")) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      obs.jsonParseFailed = true;
    }
    obs.code = parsed && parsed.error && parsed.error.code ? parsed.error.code : null;
    obs.json = normalizeJson(parsed);
  } else if ((contentType || "").includes("text/html")) {
    obs.code = null;
    obs.htmlTitle = htmlTitle(body);
    obs.htmlMarkers = htmlMarkers(body);
  } else if (opts.textMarkers) {
    obs.code = null;
    obs.bodyLength = "<not-recorded>";
    obs.bodyMarkers = opts.textMarkers.filter((m) => body.includes(m));
  } else {
    obs.code = null;
    obs.bodyLength = body.length;
    obs.body = body.length > 512 ? body.slice(0, 512) + "…<truncated>" : body;
  }

  if (opts.token) obs.tokenAppearsIn = tokenLocations(opts.token, res, body, rawHeaders);

  if (name) {
    if (!opts.skipRaw) {
      const rawRes = await SELF.fetch(`https://${name}.0g.hk/raw`);
      const rawBody = await rawRes.text();
      obs.raw = {
        status: rawRes.status,
        contentType: rawRes.headers.get("content-type"),
        bytes: rawBody.length > 512 ? rawBody.slice(0, 512) + "…<truncated>" : rawBody,
        byteLength: rawBody.length,
      };
    }
    obs.kv = {
      n: await env.NOTES.get("n:" + name),
      m: normalizeMeta(await env.NOTES.get("m:" + name)),
    };
    if (obs.kv.n != null && obs.kv.n.length > 512) {
      obs.kv.n = obs.kv.n.slice(0, 512) + "…<truncated>";
    }
  }

  if (opts.extraKeys && opts.extraKeys.length) {
    const extra: Record<string, any> = {};
    for (const key of opts.extraKeys.slice().sort()) {
      const v = await env.NOTES.get(key);
      extra[key] = v == null ? null : normalizeKvPayload(v);
    }
    obs.kvExtra = extra;
  }

  let out: any = obs;
  if (opts.randomName) {
    out = JSON.parse(JSON.stringify(obs).split(opts.randomName).join("<random>"));
  }
  return out;
}

/** Normalize a JSON-ish KV payload (d:<name> markers carry timestamps). */
function normalizeKvPayload(v: string): any {
  const t = v.trim();
  if (t.startsWith("{")) {
    try {
      return normalizeJson(JSON.parse(t));
    } catch {
      /* fall through */
    }
  }
  return v;
}

/** Window length implied by a note's meta headers, in seconds (ttl-stable). */
export function ttlWindowSec(res: Response): number | null {
  const created = res.headers.get("x-created-at");
  const expires = res.headers.get("x-expires-at");
  if (!created || !expires || expires === "never") return null;
  return Math.round((Date.parse(expires) - Date.parse(created)) / 1000);
}
