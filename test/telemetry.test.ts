// FIX-CHECKING TESTS FOR D2 — Properties 4, 5 and 6 (task 4.4).
//
// These run against the FIXED code (tasks 4.1–4.3) and are expected to PASS.
// They are the generated-coverage-free half of design.md's property→test
// mapping: rows 4, 5 and 6 are all marked "EX (parametrized)" there, because a
// generator would be slow across ordered multi-request sequences and would
// fight `recordReject`'s non-atomic read-modify-write.
//
// FOUR ENVIRONMENT CONSTRAINTS SHAPE EVERY TEST BELOW. All four were discovered
// (and paid for) by earlier tasks; none is optional.
//
// 1. ONLY TWO OF THE FIVE GATE CODES ARE REACHABLE HERE.
//    `brand_blocked` and `shortener_blocked` can be tripped through the public
//    API. `bad_scheme`, `unsafe_target` and `content_blocked` cannot — see
//    `UNREACHABLE_GATES` below, which documents the reason for each and asserts
//    the reason still holds rather than quietly pretending the code is covered.
//    design.md's Property 6 row says "for each of the five gate codes"; two are
//    exercised end-to-end and three are documented as unreachable, and the last
//    test in this file fails loudly if that partition ever drifts.
//
// 2. REQUESTS MUST BE SEQUENTIAL.
//    `recordReject` reads, increments and writes without a transaction (a
//    pre-existing KV limitation that design.md's floating-promise audit
//    explicitly left out of scope). Concurrent rejections from one address can
//    therefore lose an increment, which would make an exact-count assertion
//    flaky for a reason that has nothing to do with the property under test.
//
// 3. ONE DISTINCT `cf-connecting-ip` PER SEQUENCE, VIA `nextIp()`.
//    `rateLimit()` falls back to `ip = "0"` when the header is absent, so
//    header-less requests share a single `rl:0:<minute>` bucket AND a single
//    `rej-ip:0` counter — they would cross-contaminate exactly the counts these
//    tests assert. (`nextIp()` may hand out consecutive addresses inside one
//    /24; irrelevant here, since both the rate-limit bucket and the rejection
//    counter key on the full address string.)
//
// 4. COUNTER READS NEED A DETERMINISTIC DRAIN.
//    Post-fix a telemetry write is queued with `bg.waitUntil`, so it lands
//    AFTER the response — which is precisely what requirement 2.8 demands.
//    Under `SELF.fetch` there is no moment at which the write is guaranteed to
//    have completed, so every test here that reads a counter issues its request
//    through `fetchDrained()` (test/helpers.ts): a direct `worker.fetch(req,
//    env, ctx)` followed by `waitOnExecutionContext(ctx)`, which resolves once
//    all `waitUntil` work has settled. That keeps the assertions EXACT — no
//    polling, no sleeping, no ">= 1" — while leaving the production
//    non-blocking behavior intact. `SELF.fetch` is still used where the claim
//    is about the RESPONSE rather than a counter.
import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { fetchDrained, nextIp } from "./helpers.js";
import { REJECT_CODES, RATE_LIMIT, ADAPTIVE_RATE_LIMIT, ADAPTIVE_REJECT_THRESHOLD } from "../src/constants.js";

const APEX = "https://0g.hk";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function jsonHeaders(ip: string): Record<string, string> {
  return { "content-type": "application/json", accept: "application/json", "cf-connecting-ip": ip };
}

/** A create whose queued telemetry write is drained before we return. */
async function createDrained(body: Record<string, any>, ip: string, envOverride?: any): Promise<Response> {
  return fetchDrained(
    `${APEX}/`,
    { method: "POST", headers: jsonHeaders(ip), body: JSON.stringify(body) },
    envOverride,
  );
}

/** A create through the production dispatch path, with no drain at all. */
async function createViaSelf(body: Record<string, any>, ip: string): Promise<Response> {
  return SELF.fetch(`${APEX}/`, {
    method: "POST",
    headers: jsonHeaders(ip),
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

/** A KV counter as a number; a missing key reads as 0. */
async function kvNum(key: string): Promise<number> {
  const raw = await env.NOTES.get(key);
  return parseInt(raw || "0", 10) || 0;
}

/** recordReject's day key format: YYYYMMDD. */
function dayKey(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Per-code `rej:<day>:<code>` counts, summed over the supplied day keys.
 *
 * Two days are passed whenever a sequence could straddle UTC midnight: a
 * rollover mid-sequence would otherwise split the increments across two key
 * families and understate the total.
 */
async function rejCounts(days: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const code of REJECT_CODES) {
    let total = 0;
    for (const day of days) total += await kvNum(`rej:${day}:${code}`);
    out[code] = total;
  }
  return out;
}

function countDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of REJECT_CODES) out[code] = (after[code] || 0) - (before[code] || 0);
  return out;
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/** The expected per-code delta for a sequence of gate codes, over all REJECT_CODES. */
function expectedDelta(gates: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of REJECT_CODES) out[code] = gates.filter((g) => g === code).length;
  return out;
}

// A monotonic suffix, so no two gate-tripping requests are byte-identical (a
// repeated payload would hit aiModerate's `aimod:` cache and, for brand names,
// reuse a name — neither changes the gate outcome, but distinct inputs make a
// failure easier to read).
let probe = 0;

/**
 * Request bodies for the two gate codes reachable through the public API.
 *
 * `brand_blocked` is name-driven: `isBrandSquatting(name)` matches a BRAND_BLOCK
 * substring ("paypal"), and the check sits after the rate limiter and before any
 * URL gate. `shortener_blocked` is content-driven: `bit.ly` is in
 * SHORTENER_HOSTS. Neither request ever creates a note, so names may repeat.
 */
const REACHABLE_GATES: Array<{ code: string; status: number; detailsKey: string; body: () => Record<string, any> }> = [
  {
    code: "brand_blocked",
    status: 400,
    detailsKey: "term",
    body: () => ({ name: `paypal-probe-${probe++}`, content: "gate probe text" }),
  },
  {
    code: "shortener_blocked",
    status: 400,
    detailsKey: "host",
    body: () => ({ content: `https://bit.ly/probe${probe++}` }),
  },
];

function gateBody(code: string): Record<string, any> {
  const g = REACHABLE_GATES.find((x) => x.code === code);
  if (!g) throw new Error(`no reachable request shape for gate code ${code}`);
  return g.body();
}

// ===========================================================================
// Property 4 — rejection accounting is exact
// ===========================================================================

describe("Property 4: rejection accounting is exact (2.8, 2.9, 2.11)", () => {
  // design.md: "For any request sequence from a single IP containing n gate
  // rejections, SUM(rej:<day>:<code>) over REJECT_CODES = n and rej-ip:<ip> = n."
  //
  // The sum is taken over ALL FIVE REJECT_CODES rather than only the codes used,
  // which is strictly stronger: a rejection filed under an unexpected code would
  // keep the total right but is caught by the per-code assertion, and a
  // double-count anywhere shows up in the total.
  //
  // RATE-LIMIT BUDGET (why 5 rejections still fit): the default cap is
  // RATE_LIMIT (10) per minute, and `rateLimit()` tightens it to
  // ADAPTIVE_RATE_LIMIT (2) only once `rej-ip:<ip>` has reached
  // ADAPTIVE_REJECT_THRESHOLD (5). On request i (1-based) the bucket holds i-1
  // and the rejection counter holds i-1, so for i <= 5 the counter is <= 4, the
  // cap is still 10, and 4 < 10 — all five requests reach their gate. The
  // sequence therefore never turns a gate rejection into a `rate_limited`, which
  // the per-request code assertion below verifies rather than assumes.
  const SEQUENCES: Array<{ n: number; gates: string[] }> = [
    { n: 1, gates: ["shortener_blocked"] },
    { n: 3, gates: ["shortener_blocked", "brand_blocked", "shortener_blocked"] },
    { n: 5, gates: ["brand_blocked", "shortener_blocked", "brand_blocked", "shortener_blocked", "brand_blocked"] },
  ];

  it.each(SEQUENCES)("a sequence of $n gate rejection(s) is counted exactly once each", async ({ n, gates }) => {
    const ip = nextIp();
    const startDay = dayKey();
    const before = await rejCounts([startDay]);

    // SEQUENTIAL, and each request drained before the next one is issued: the
    // adaptive cap read by request i+1 must see the write made by request i.
    const observed: Array<{ i: number; status: number; code: string | null }> = [];
    for (let i = 0; i < gates.length; i++) {
      const res = await createDrained(gateBody(gates[i]), ip);
      const j: any = await res.json();
      observed.push({ i, status: res.status, code: j?.error?.code ?? null });
    }

    // Guard against the whole test degenerating: if the plain rate limiter (or
    // anything else) answered instead of a gate, the counts below would be
    // "correct" for the wrong reason.
    expect(observed, "every request in the sequence must be rejected by its intended gate, not rate-limited").toEqual(
      gates.map((code, i) => ({ i, status: 400, code })),
    );

    // `before` was read for startDay only; if UTC midnight passed mid-sequence
    // the new day's counters started at 0, so summing `after` over both days
    // against that baseline is still exact.
    const days = startDay === dayKey() ? [startDay] : [startDay, dayKey()];
    const delta = countDelta(before, await rejCounts(days));

    expect(sumCounts(delta), `SUM(rej:<day>:<code>) over REJECT_CODES must have advanced by exactly ${n}`).toBe(n);
    expect(delta, "each gate code must be credited exactly as many times as it fired").toEqual(expectedDelta(gates));
    expect(await kvNum(`rej-ip:${ip}`), `rej-ip:${ip} must equal the ${n} rejection(s) from that address`).toBe(n);
  });
});

// ===========================================================================
// Property 5 — the adaptive cap engages
// ===========================================================================

describe("Property 5: the adaptive cap engages (2.10)", () => {
  // design.md: "For any request sequence from a single IP containing at least
  // ADAPTIVE_REJECT_THRESHOLD (5) gate rejections, accept at most
  // ADAPTIVE_RATE_LIMIT (2) subsequent same-minute write requests from that IP
  // and answer 429 rate_limited to the rest."
  //
  // The five rejections consume 5 of the address's 10/min budget — intended, and
  // the reason the follow-ups are throttled with room to spare: once `rej-ip`
  // reaches 5 the cap drops to 2, the bucket already holds 5, and 5 >= 2, so
  // every follow-up in that same minute is refused. If the minute happens to
  // roll over mid-test the bucket resets to 0 while `rej-ip:<ip>` (15-minute
  // TTL) does not, so the first 2 follow-ups are accepted and the remaining 2
  // are refused — still "at most 2 non-429", and still at least one 429 to
  // inspect. Both schedules satisfy the assertions below, so there is no timing
  // tolerance here.
  it("five rejections cap the offending address at ADAPTIVE_RATE_LIMIT for the minute", async () => {
    const ip = nextIp();

    for (let i = 0; i < ADAPTIVE_REJECT_THRESHOLD; i++) {
      const res = await createDrained({ content: `https://bit.ly/cap${i}` }, ip);
      const j: any = await res.json();
      expect({ i, status: res.status, code: j?.error?.code ?? null }).toEqual({
        i,
        status: 400,
        code: "shortener_blocked",
      });
    }

    expect(
      await kvNum(`rej-ip:${ip}`),
      `rej-ip:${ip} must have reached ADAPTIVE_REJECT_THRESHOLD (${ADAPTIVE_REJECT_THRESHOLD}) for the cap to engage`,
    ).toBe(ADAPTIVE_REJECT_THRESHOLD);

    const outcomes: Array<{ i: number; status: number; code: string | null; details: any }> = [];
    for (let i = 0; i < 4; i++) {
      const res = await createDrained({ content: `adaptive cap follow up ${i}` }, ip);
      const j: any = await res.json();
      outcomes.push({ i, status: res.status, code: j?.error?.code ?? null, details: j?.error?.details ?? null });
    }

    const accepted = outcomes.filter((o) => o.status !== 429);
    expect(
      accepted.length,
      `at most ADAPTIVE_RATE_LIMIT (${ADAPTIVE_RATE_LIMIT}) of the 4 follow-up creates may be non-429; ` +
        `outcomes were ${JSON.stringify(outcomes.map((o) => o.status))}`,
    ).toBeLessThanOrEqual(ADAPTIVE_RATE_LIMIT);

    const throttled = outcomes.filter((o) => o.status === 429);
    expect(throttled.length, "4 follow-ups against a cap of 2 must produce at least one 429").toBeGreaterThan(0);
    for (const t of throttled) {
      expect(
        { code: t.code, details: t.details },
        "every 429 must keep the documented rate_limited envelope (3.9)",
      ).toEqual({ code: "rate_limited", details: { limit: RATE_LIMIT, windowSeconds: 60 } });
    }
  });
});

// ===========================================================================
// Property 6 — telemetry never blocks or breaks the response
// ===========================================================================

describe("Property 6: telemetry never blocks or breaks the response (2.7, 3.8)", () => {
  // The status and JSON `code` are asserted against ABSOLUTE expected values,
  // not against a live comparison with the pre-fix code: F and F' cannot both be
  // loaded in one Worker isolate (design.md, *Preservation Checking*), so the
  // pre-fix values are hard-coded here and cross-checked by the recorded
  // preservation fixture from task 1.
  it.each(REACHABLE_GATES)(
    "$code still answers $status with code $code through the production dispatch path",
    async ({ code, status, detailsKey, body }) => {
      // Deliberately SELF.fetch with NO drain: the response is inspected on its
      // own terms, exactly as a client sees it, while the telemetry write is
      // still outstanding. That the write is not awaited on this path is a
      // property of `makeBackground` + a real ExecutionContext (settle() is a
      // no-op), covered directly by the makeBackground unit tests in
      // test/util.test.ts; here the point is that the response is complete and
      // unchanged regardless.
      const res = await createViaSelf(body(), nextIp());
      const j: any = await res.json();

      expect({ status: res.status, code: j?.error?.code ?? null }).toEqual({ status, code });
      expect(j.ok, "the error envelope shape is unchanged").toBe(false);
      expect(typeof j.error.message).toBe("string");
      expect(j.error.details, `details.${detailsKey} is part of the pre-fix envelope`).toHaveProperty(detailsKey);
    },
  );

  // The "never breaks" half, made deterministic: hand the Worker a KV binding
  // whose `put` throws for `rej:` / `rej-ip:` keys only. `recordReject` has an
  // internal try/catch and `makeBackground` wraps every queued promise in
  // `.catch(ignore)`, so a failed telemetry write must be invisible to the
  // client. The zero-delta assertion is the non-vacuity guard: it proves the
  // failure was actually injected rather than silently skipped.
  it.each(REACHABLE_GATES)(
    "$code is answered identically when the telemetry write itself fails",
    async ({ code, status, body }) => {
      const ip = nextIp();
      const day = dayKey();
      const before = await rejCounts([day]);

      const res = await createDrained(body(), ip, envWithFailingRejectWrites());
      const j: any = await res.json();

      expect({ status: res.status, code: j?.error?.code ?? null }).toEqual({ status, code });

      const delta = countDelta(before, await rejCounts([day]));
      expect(sumCounts(delta), "the injected failure must really have blocked the telemetry write").toBe(0);
      expect(await kvNum(`rej-ip:${ip}`), "and the per-IP counter must be untouched too").toBe(0);
    },
  );

  // The three gate codes that CANNOT be reached through the public API in this
  // environment. They are listed — not dropped — so the gap is visible, and the
  // assertions below re-verify each stated reason instead of trusting the
  // comment. Task 2 recorded the same finding in
  // test/__fixtures__/preservation-baseline.json under NOT_EXERCISED.
  const UNREACHABLE_GATES: Array<{ code: string; why: string }> = [
    {
      code: "bad_scheme",
      why:
        "hasDangerousScheme() is consulted only when isUrl(content) is true, but every javascript:/data:/" +
        "vbscript:/file: string fails URL_NO_SCHEME_RE (the colon and the missing dotted host), and any " +
        "isUrl()-true string has already been normalized to http(s). No input reaches this gate.",
    },
    {
      code: "unsafe_target",
      why: "checkSafeBrowsing() returns {ok:true} immediately when SAFE_BROWSING_KEY is unset, and it is unset here.",
    },
    {
      code: "content_blocked",
      why:
        "env.AI.run throws 'Binding AI needs to be run remotely' in the local runtime, and aiModerate() fails " +
        "open on any error, so no content is ever classified as abusive.",
    },
  ];

  it("the five gate codes are partitioned into exercised and documented-unreachable", () => {
    const exercised = REACHABLE_GATES.map((g) => g.code);
    const unreachable = UNREACHABLE_GATES.map((g) => g.code);
    // If a gate is added, renamed, or becomes reachable, this fails and forces a
    // deliberate decision rather than letting coverage silently shrink.
    expect([...exercised, ...unreachable].sort()).toEqual([...REJECT_CODES].sort());
    expect(exercised.filter((c) => unreachable.includes(c)), "no code may be in both lists").toEqual([]);
    for (const g of UNREACHABLE_GATES) expect(g.why.length, `${g.code} must carry a reason`).toBeGreaterThan(40);
  });

  it("bad_scheme is unreachable: a javascript: payload is stored as a text note, not rejected", async () => {
    const day = dayKey();
    const before = await kvNum(`rej:${day}:bad_scheme`);

    const res = await createDrained({ content: "javascript:alert(1)" }, nextIp());
    const j: any = await res.json();

    expect({ status: res.status, kind: j.kind }, "the payload is not a URL by isUrl(), so no URL gate runs").toEqual({
      status: 201,
      kind: "text",
    });
    expect(await kvNum(`rej:${day}:bad_scheme`), "and nothing was recorded under bad_scheme").toBe(before);
  });

  it("unsafe_target is unreachable: SAFE_BROWSING_KEY is not configured", async () => {
    expect((env as any).SAFE_BROWSING_KEY ?? null, "checkSafeBrowsing() short-circuits to {ok:true}").toBeNull();

    const day = dayKey();
    const before = await kvNum(`rej:${day}:unsafe_target`);
    const res = await createDrained({ content: "https://example.com/target" }, nextIp());
    const j: any = await res.json();
    expect({ status: res.status, kind: j.kind }).toEqual({ status: 201, kind: "url" });
    expect(await kvNum(`rej:${day}:unsafe_target`)).toBe(before);
  });

  it("content_blocked is unreachable: aiModerate fails open in this runtime", async () => {
    const day = dayKey();
    const before = await kvNum(`rej:${day}:content_blocked`);

    const res = await createDrained({ content: "buy cheap pills click here to verify your bank login" }, nextIp());
    const j: any = await res.json();

    expect(res.status, "moderation cannot classify anything, so the create is accepted").toBe(201);
    expect(j.ok).toBe(true);
    expect(await kvNum(`rej:${day}:content_blocked`), "nothing was recorded under content_blocked").toBe(before);
  });
});

// ===========================================================================
// Property 11 (indirect) — /admin/stats reports what actually happened
// ===========================================================================

describe("Property 11 (indirect via task 4.4): /admin/stats reflects the rejections that occurred (2.11)", () => {
  // Requirement 2.11 is about the operator-visible end of the same counters:
  // whatever `recordReject` wrote must be what `/admin/stats` reports. With the
  // telemetry writes lost (pre-fix) the dashboard under-reported; the check is
  // therefore a delta over one day's row, not an absolute count, since other
  // tests in this file legitimately add to the same day.
  it("the day row advances by exactly the rejections just issued", async () => {
    const ADMIN_KEY = "task44-admin-key";
    const prevKey = (env as any).ADMIN_KEY;
    (env as any).ADMIN_KEY = ADMIN_KEY;

    const readStats = async (day: string): Promise<Record<string, number>> => {
      const res = await SELF.fetch(`${APEX}/admin/stats`, {
        headers: { accept: "application/json", authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status, "the admin JSON API must be reachable with a Bearer key").toBe(200);
      const j: any = await res.json();
      return j.days[day] || {};
    };

    try {
      const day = dayKey();
      const before = await readStats(day);

      const ip = nextIp();
      const gates = ["shortener_blocked", "brand_blocked", "shortener_blocked"];
      for (const code of gates) {
        const res = await createDrained(gateBody(code), ip);
        const j: any = await res.json();
        expect({ status: res.status, code: j?.error?.code ?? null }).toEqual({ status: 400, code });
      }

      const after = await readStats(day);
      expect(countDelta(before, after), "/admin/stats must report exactly the rejections that occurred").toEqual(
        expectedDelta(gates),
      );
    } finally {
      if (prevKey === undefined) delete (env as any).ADMIN_KEY;
      else (env as any).ADMIN_KEY = prevKey;
    }
  });
});

// ---------------------------------------------------------------------------
// A binding set whose telemetry writes fail
// ---------------------------------------------------------------------------

/**
 * `env`, but with a NOTES namespace that refuses to write `rej:` / `rej-ip:`
 * keys. Every other operation (the note itself, the rate-limit bucket, the
 * moderation cache) is delegated untouched, so the only injected fault is on the
 * telemetry path.
 *
 * A Proxy is used rather than `{...env}` so no binding is read eagerly — the AI
 * binding throws on access in this runtime. Only the direct-worker call gets
 * this object, so nothing else in the run is affected.
 */
function envWithFailingRejectWrites(): any {
  const kv = env.NOTES as any;
  const notes = {
    get: (...a: any[]) => kv.get(...a),
    getWithMetadata: (...a: any[]) => kv.getWithMetadata(...a),
    list: (...a: any[]) => kv.list(...a),
    delete: (...a: any[]) => kv.delete(...a),
    put: async (key: string, value: any, opts?: any) => {
      if (key.startsWith("rej:") || key.startsWith("rej-ip:")) {
        throw new Error("simulated KV failure on a telemetry write");
      }
      return kv.put(key, value, opts);
    },
  };
  return new Proxy(env as any, {
    get(target, prop, receiver) {
      if (prop === "NOTES") return notes;
      return Reflect.get(target, prop, receiver);
    },
  });
}
