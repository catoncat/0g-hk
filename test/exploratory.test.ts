// EXPLORATORY BUG-CONDITION TESTS — EVERY FAILURE IN THIS FILE IS INTENTIONAL
// RIGHT NOW.
//
// Recorded against the UNFIXED tree at git sha e633f33 ("test: record the
// Property 16 preservation baseline against the unfixed code"), which is the
// last commit before any file under src/ is touched by this spec.
//
// WHY A RED FILE IS THE CORRECT OUTPUT AT THIS STAGE
// -------------------------------------------------
// These eight cases encode the FINAL EXPECTED BEHAVIOR of the four defects
// (D1–D4) described in .kiro/specs/write-path-security-hardening/bugfix.md.
// Run against the current code they FAIL, and the failure text is the
// counterexample that confirms the root-cause analysis. A case that passed here
// would prove nothing — see design.md's *Exploratory Bug Condition Checking*.
//
// DO NOT "fix" these tests. DO NOT touch src/ to make them green.
// Tasks 4.5 (cases 3, 4), 5.7 (cases 7, 8) and 6.12 (cases 1, 2, 5, 6) re-run
// this file UNCHANGED as the fix check. When each fix lands, the corresponding
// case turns green with no edit to this file.
//
// WHY PLAIN `it(...)` AND NOT `it.fails(...)`
// ------------------------------------------
// `it.fails` would keep the suite green today, but it INVERTS the assertion:
// the moment the fix lands, a now-correct test would be reported as failing,
// and someone would have to edit every case back to `it`. Tasks 4.5/5.7/6.12
// explicitly re-run these cases *unchanged*, so the inversion would be a
// guaranteed future edit in exactly the place where a mistake is most
// expensive. Plain `it` keeps the file text stable across the whole spec: red
// now, green after the fix, zero edits. The loud describe-block names below
// carry the "expected to fail" signal instead.
//
// EXPECTED STATE WHEN THIS FILE WAS WRITTEN (unfixed): every case fails, except
// that case 3's failure was timing-dependent and a pass there would have
// refuted nothing.
//
// STATUS AFTER D2 LANDED (tasks 4.1–4.4): cases 3 and 4 pass; cases 1, 2 (D1)
// and 5, 6 (D3) and 7, 8 (D4) still fail, as intended, until tasks 5 and 6.
// Case 3 no longer carries the "INCONCLUSIVE ON PASS" label: task 4.4 changed
// its assertion MECHANISM (not its strength) to a deterministic
// `waitOnExecutionContext` drain, so it is now a real check rather than a
// coin-flip — see its comment for the full reasoning. That is the ONLY case in
// this file whose text has changed since it was recorded.
//
// DEVIATION FROM design.md — DOCUMENTED PLAN vs REALITY
// ----------------------------------------------------
// design.md's exploratory cases 3 and 4 say to trigger a rejection with
// `content: "javascript:alert(1)"` and read `rej:<day>:bad_scheme`. That is
// IMPOSSIBLE in the current code: `hasDangerousScheme()` is only consulted when
// `isUrl()` is true, every `javascript:` / `data:` / `vbscript:` / `file:`
// string fails `URL_NO_SCHEME_RE` (the `:` and the missing dotted host), and
// any `isUrl()`-true string has already been normalized to http(s). So
// `bad_scheme` is UNREACHABLE through the public API for ANY input, and
// `javascript:alert(1)` yields a 201 *text* note. (Task 1 recorded this in
// test/__fixtures__/preservation-baseline.json under NOT_EXERCISED.)
// `content_blocked` (env.AI.run throws in the sandbox; aiModerate fails open)
// and `unsafe_target` (no SAFE_BROWSING_KEY) are unreachable here too.
// Cases 3 and 4 therefore use `shortener_blocked` (`https://bit.ly/…`,
// reachable on create AND edit). This changes only WHICH GATE fires; it does
// not touch D2's root cause, which is the missing `ctx.waitUntil` around
// `recordReject`. Fixing `bad_scheme`'s reachability is out of scope.
//
// SECOND DEVIATION — CASE 1 CANNOT USE `SELF.fetch`
// ------------------------------------------------
// design.md's case 1 says "spy on console.log, SELF.fetch(...)". That cannot
// work, for two independent reasons found by direct experiment:
//   1. SELF dispatches to the Worker in a SEPARATE isolate, so a test-side
//      console spy never sees its console.
//   2. hono's `logger(fn = console.log)` binds console.log as a DEFAULT
//      PARAMETER at module-evaluation time, so even in one isolate a spy
//      installed later is invisible.
// Case 1 therefore drives its one asserted request through
// `workerWithLogCapture()` (test/helpers.ts), a second, freshly-evaluated
// instance of the Worker entry that shares `env` with SELF and whose logger
// output IS observable. Everything else still uses SELF.fetch. This is a
// harness gap in task 1's helpers, closed here rather than worked around,
// because tasks 4.4 and 6.11 need the same primitive.
import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { captureLogs, expectRedactedLogPresent, fetchDrained, nextIp, workerWithLogCapture } from "./helpers.js";

const APEX = "https://0g.hk";

// ---------------------------------------------------------------------------
// Local helpers (same shapes as test/preservation.test.ts)
// ---------------------------------------------------------------------------

function jsonHeaders(ip: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", accept: "application/json", "cf-connecting-ip": ip, ...extra };
}

/** Create via the JSON API. `ip` is explicit so a sequence shares one bucket. */
async function createJson(body: Record<string, any>, ip: string = nextIp(), extra: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${APEX}/`, {
    method: "POST",
    headers: jsonHeaders(ip, extra),
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

/**
 * The same create, issued through the direct-worker path with a deterministic
 * drain of `waitUntil` work (see `fetchDrained` in test/helpers.ts). Used by
 * case 3, whose claim is about a counter written in the background.
 */
async function createJsonDrained(body: Record<string, any>, ip: string): Promise<Response> {
  return fetchDrained(`${APEX}/`, {
    method: "POST",
    headers: jsonHeaders(ip),
    body: JSON.stringify(body),
  });
}

/** Create a note and return its edit token. Throws if the create was rejected. */
async function seedNote(name: string, content: string, ttl?: string): Promise<string> {
  const res = await createJson({ name, content, ...(ttl ? { ttl } : {}) });
  const j: any = await res.json();
  if (!j.editToken) throw new Error(`seed failed for ${name}: ${res.status} ${JSON.stringify(j)}`);
  return j.editToken as string;
}

async function editJson(name: string, body: Record<string, any>, extra: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`https://${name}.0g.hk/`, {
    method: "POST",
    headers: jsonHeaders(nextIp(), extra),
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(url, { headers: { "cf-connecting-ip": nextIp(), ...headers }, redirect: "manual" });
}

/** A KV counter as a number; a missing key reads as 0. */
async function kvNum(key: string): Promise<number> {
  const raw = await env.NOTES.get(key);
  return parseInt(raw || "0", 10) || 0;
}

async function meta(name: string): Promise<any> {
  const raw = await env.NOTES.get("m:" + name);
  return raw == null ? null : JSON.parse(raw);
}

/** recordReject's day key format: YYYYMMDD. */
function dayKey(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/** POST /abuse/report from a chosen source address (the address is the input). */
async function report(name: string, ip: string, body: Record<string, any> = {}): Promise<Response> {
  return SELF.fetch(`https://${name}.0g.hk/abuse/report`, {
    method: "POST",
    headers: jsonHeaders(ip),
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

// ===========================================================================
// D1 — the edit token must never reach a URL or a log line
// ===========================================================================

describe("EXPLORATORY (expected to FAIL until task 6 lands) — D1: token confidentiality", () => {
  // Case 1 — bugfix.md 1.1 / 1.2, expected behavior 2.2.
  // Counterexample expected today: hono's logger() prints the full path plus
  // query, so a line like `<-- GET /?edit=<token>&c=x` carries the owner's
  // credential. Fixed by 6.2 + 6.3 (redactLogLine on both logger instances).
  //
  // The second assertion is the NON-VACUITY GUARD and is load-bearing: "no
  // captured line contains the token" is trivially true when nothing was
  // logged at all, so the test also demands that a line was emitted AND
  // redacted. Both halves fail today (nothing is redacted).
  it("case 1: no log line contains the raw edit token (deprecated ?edit= GET form)", async () => {
    const name = "explore-log-token";
    const token = await seedNote(name, "hello world");

    // See the header: this one request goes through the log-observable Worker
    // instance rather than SELF, because hono's logger() is otherwise invisible.
    const observable = await workerWithLogCapture();
    const cap = captureLogs();
    let res: Response;
    try {
      const req = new Request(`https://${name}.0g.hk/?edit=${encodeURIComponent(token)}&c=x`, {
        headers: { "cf-connecting-ip": nextIp() },
      });
      // A real ExecutionContext is passed even though today's fetch(req, env)
      // ignores it: task 4.2 starts accepting it, and waitOnExecutionContext
      // then drains any waitUntil work before the assertions run.
      const ctx = createExecutionContext();
      res = await observable.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);
      await res.text();
    } finally {
      cap.restore();
    }
    expect(res.status).toBe(200); // the deprecated transport still mutates (2.3)

    const leaking = cap.lines.filter((l) => l.includes(token));
    expect(leaking, `captured log line(s) containing the raw edit token:\n${leaking.join("\n")}`).toEqual([]);
    expectRedactedLogPresent(cap.lines);
  });

  // Case 2 — bugfix.md 1.4, expected behavior 2.4.
  // Counterexample expected today: `400 missing_token`, because handleEdit
  // reads the token only from the body or `?edit=`. Fixed by 6.4.
  it("case 2: an edit token supplied in X-Edit-Token is accepted", async () => {
    const name = "explore-hdr-token";
    const token = await seedNote(name, "hello world");

    const res = await editJson(name, { content: "x" }, { "x-edit-token": token });
    const j: any = await res.json();
    expect(
      { status: res.status, code: j?.error?.code ?? null },
      "the header transport must validate identically to the body transport (2.4)",
    ).toEqual({ status: 200, code: null });

    const raw = await get(`https://${name}.0g.hk/raw`);
    expect(await raw.text()).toBe("x");
  });
});

// ===========================================================================
// D2 — every gate rejection must be recorded exactly once
// ===========================================================================

describe("EXPLORATORY (expected to FAIL until task 4 lands) — D2: rejection telemetry", () => {
  // Case 3 — bugfix.md 1.5, expected behavior 2.9.
  //
  // MECHANISM CHANGED IN TASK 4.4 — ASSERTION STRENGTH UNCHANGED.
  //
  // As originally written this case drove its request through `SELF.fetch` and
  // read the counter immediately after `await res.json()`. Pre-fix that made a
  // PASS inconclusive (the floating promise might happen to settle in time).
  // Post-fix it made a PASS IMPOSSIBLE, for the opposite reason: `bg.waitUntil`
  // now lands the telemetry write AFTER the response, which is exactly what
  // requirement 2.8 demands. Observed at that point: `before=0 immediate=0
  // delayed=1` — the write is not lost, merely not yet landed. Reading the
  // counter straight after the response therefore asserted a TIMING GUARANTEE
  // ("the write completed before the response") that 2.8 forbids, so the case
  // could never go green no matter how correct the fix was.
  //
  // The repair is the assertion MECHANISM only: the request now goes through
  // the direct-worker path (the same one case 1 uses via
  // `workerWithLogCapture()`), with `createExecutionContext()` +
  // `waitOnExecutionContext(ctx)`. That drain is DETERMINISTIC — it resolves
  // once every `waitUntil`-queued promise has settled — so no polling, sleep,
  // or timing tolerance is involved. The claim is still the exact one from
  // 2.9: `rej:<day>:<code>` advanced by EXACTLY 1 and `rej-ip:<ip>` is EXACTLY
  // 1. Nothing was relaxed to ">= 1", and no retry loop was added.
  //
  // Case 4 remains the authoritative end-to-end D2 signal (it observes the
  // consequence — the adaptive cap — through SELF with no drain at all).
  //
  // Gate substituted per the file header: shortener_blocked, not bad_scheme.
  it("case 3: one rejection increments rej:<day>:<code> and rej-ip:<ip> exactly once", async () => {
    const ip = nextIp();
    const code = "shortener_blocked";
    const key = `rej:${dayKey()}:${code}`;
    const before = await kvNum(key);

    const res = await createJsonDrained({ content: "https://bit.ly/abc" }, ip);
    const j: any = await res.json();
    expect({ status: res.status, code: j?.error?.code }).toEqual({ status: 400, code });

    expect(await kvNum(key), `${key} must have advanced by exactly 1`).toBe(before + 1);
    expect(await kvNum(`rej-ip:${ip}`), `rej-ip:${ip} must be 1 after one rejection`).toBe(1);
  });

  // Case 4 — bugfix.md 1.8, expected behavior 2.10. THE AUTHORITATIVE D2 SIGNAL.
  //
  // Five rejections push `rej-ip:<ip>` to ADAPTIVE_REJECT_THRESHOLD (5), which
  // must tighten the cap to ADAPTIVE_RATE_LIMIT (2/min) for that address. The
  // five rejected creates already consumed 5 of the 10/min budget, so once the
  // adaptive cap engages every subsequent create in the same minute is 429 —
  // hence "at most 2 non-429" is satisfied post-fix with room to spare.
  //
  // Counterexample expected today: all three creates accepted (3 non-429),
  // because the lost telemetry writes leave `rej-ip:<ip>` below 5 and the
  // address keeps the full 10/min budget.
  //
  // SEQUENTIAL BY NECESSITY: recordReject's read-modify-write is non-atomic
  // (out of scope to fix), so concurrent requests can lose an increment and
  // make this flaky for a reason unrelated to the defect.
  it("case 4: five rejections engage the adaptive cap (2/min) on the offending address", async () => {
    const ip = nextIp();

    for (let i = 0; i < 5; i++) {
      const res = await createJson({ content: `https://bit.ly/r${i}` }, ip);
      const j: any = await res.json();
      expect({ i, status: res.status, code: j?.error?.code }).toEqual({ i, status: 400, code: "shortener_blocked" });
    }

    const rejIp = await kvNum(`rej-ip:${ip}`);

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await createJson({ content: `exploratory adaptive cap ${i}` }, ip);
      statuses.push(res.status);
      await res.text();
    }

    const accepted = statuses.filter((s) => s !== 429).length;
    expect(
      accepted,
      `after 5 rejections rej-ip:${ip} = ${rejIp} (needs >= 5 for the adaptive cap); ` +
        `follow-up create statuses were [${statuses.join(", ")}] — at most 2 may be non-429`,
    ).toBeLessThanOrEqual(2);
  });
});

// ===========================================================================
// D3 — abuse reporting must not be weaponisable
// ===========================================================================

describe("EXPLORATORY (expected to FAIL until task 6 lands) — D3: abuse reporting", () => {
  // Case 5 — bugfix.md 1.10 / 1.11, expected behavior 2.14 / 2.15 / 2.17.
  // Three addresses inside ONE /64 must count as ONE reporter, and one
  // reporter must never reach the auto-action threshold.
  //
  // Counterexample expected today: the dedupe key truncates by
  // `split(":").slice(0,4)`, which does not survive `::` compression, so
  // `2001:db8::1/::2/::3` look like three distinct reporters, `abuse:<name>`
  // reaches ABUSE_AUTO_DISABLE (3), and `d:<name>` is written with a 365-day
  // TTL — a legitimate note answers 410 for a year on one actor's word.
  // Fixed by 6.6 (threshold 10) + 6.7 (reporterGroup) + 6.8 (group dedupe).
  it("case 5: three addresses in one IPv6 /64 cannot disable a note", async () => {
    const name = "explore-group-64";
    await seedNote(name, "hello world");

    const addrs = ["2001:db8::1", "2001:db8::2", "2001:db8::3"];
    const reportStatuses: number[] = [];
    for (const addr of addrs) {
      const res = await report(name, addr);
      reportStatuses.push(res.status);
      await res.text();
    }

    const counter = await kvNum(`abuse:${name}`);
    const marker = await env.NOTES.get(`d:${name}`);
    expect(
      marker,
      `d:${name} must be absent: abuse:${name} = ${counter} after 3 addresses in one /64 ` +
        `(report statuses [${reportStatuses.join(", ")}]); marker = ${marker}`,
    ).toBeNull();

    const read = await get(`https://${name}.0g.hk/`);
    await read.text();
    expect(read.status, "the note must stay readable (2.14)").not.toBe(410);
  });

  // Case 6 — bugfix.md 1.9 / 1.12, expected behavior 2.12.
  // With TURNSTILE_SECRET configured and no challenge token presented, the
  // report must be fully INERT: rejected before any counter is read or written.
  //
  // Counterexample expected today: 200 and the counter increments, because
  // `verifyTurnstile()` has zero call sites anywhere in the codebase.
  //
  // NOTE ON THE ASSERTION SHAPE: verifyTurnstile() FAILS OPEN on a network
  // error, and the sandbox cannot reach challenges.cloudflare.com. That is
  // irrelevant here because a MISSING token short-circuits to
  // `{ok:false, reason:"missing"}` before any fetch. The claim under test is
  // that the function is never CALLED at all, so the counter — not a network
  // result — is the evidence. Fixed by 6.8.
  it("case 6: an unverified report is inert when TURNSTILE_SECRET is configured", async () => {
    const name = "explore-challenge";
    await seedNote(name, "hello world");

    const before = await kvNum(`abuse:${name}`);
    const prevSecret = (env as any).TURNSTILE_SECRET;
    (env as any).TURNSTILE_SECRET = "exploratory-secret-never-dialled";
    let res: Response;
    try {
      res = await report(name, "203.0.113.7"); // no challenge token in the body
      await res.text();
    } finally {
      if (prevSecret === undefined) delete (env as any).TURNSTILE_SECRET;
      else (env as any).TURNSTILE_SECRET = prevSecret;
    }

    const after = await kvNum(`abuse:${name}`);
    expect(
      { status: res.status, counterAdvancedBy: after - before },
      "an unverified report must be rejected without incrementing any counter (2.12)",
    ).toEqual({ status: 403, counterAdvancedBy: 0 });
    expect(await env.NOTES.get(`d:${name}`)).toBeNull();
  });
});

// ===========================================================================
// D4 — the note kind must be decided once, at write time
// ===========================================================================

describe("EXPLORATORY (expected to FAIL until task 5 lands) — D4: persisted note kind", () => {
  // Case 7 — bugfix.md 1.18, expected behavior 2.19.
  // Counterexample expected today: `m:<name>` = {"v":1,"h":…,"t":"7d","ct":…}
  // with no `k`, so nothing recorded at write time can be trusted at read
  // time and a fuzzy regex decides a security-relevant branch on every read.
  // Fixed by 5.1 + 5.2.
  it("case 7: create persists the resolved kind in m:<name>.k", async () => {
    const name = "explore-kind-meta";
    await seedNote(name, "hello world");

    const m = await meta(name);
    expect(m, `m:${name} = ${JSON.stringify(m)} — expected a k field`).toHaveProperty("k");
    expect(m.k).toBe("text");
  });

  // Case 8 (edge case) — bugfix.md 1.16, expected behavior 2.19 / 2.22 / 2.24.
  // A content rewrite MAY still flip a note from text to url — that stays
  // allowed. What must change is that the flip is RECORDED: `k` moves to
  // "url" on the explicit content rewrite, and the read branch follows the
  // persisted `k` rather than re-deriving it. `docs.example.com` is not on
  // REDIRECT_ALLOWLIST, so the url branch is the interstitial, not a 302.
  //
  // Counterexample expected today: `k` never exists in either state, so the
  // note silently becomes a redirect-ish note with no owner signal and no
  // stored record of the transition. Fixed by 5.2 + 5.3 + 5.4.
  it("case 8: a text -> url content rewrite is recorded in m:<name>.k", async () => {
    const name = "explore-kind-flip";
    const token = await seedNote(name, "hello world");

    const before = await meta(name);
    expect(before, `m:${name} before the edit = ${JSON.stringify(before)}`).toMatchObject({ k: "text" });

    const edited = await editJson(name, { content: "docs.example.com", token });
    const ej: any = await edited.json();
    expect({ status: edited.status, kind: ej.kind }).toEqual({ status: 200, kind: "url" });
    expect(edited.headers.get("x-kind")).toBe("url");

    const after = await meta(name);
    expect(after, `m:${name} after the content rewrite = ${JSON.stringify(after)}`).toMatchObject({ k: "url" });

    const read = await get(`https://${name}.0g.hk/`);
    const body = await read.text();
    expect(read.status).toBe(200);
    expect(body, "the read branch must follow the persisted kind (url, non-allowlisted => interstitial)").toContain("即将离开");
  });
});
