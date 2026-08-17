// FIX-CHECKING TESTS FOR D1 + D3 — Properties 2, 3, 7, 9, 10 (task 6.11).
//
// Properties 1 (redactLogLine) and 8 (reporterGroup) are unit-level and live in
// test/util.test.ts next to the pure functions they exercise. This file holds
// the ones that need the Worker.
//
// TWO HARNESS REQUIREMENTS APPLY (design.md, *Validation Approach*):
//
// (a) LOG CAPTURE + THE NON-VACUITY GUARD. "No log line contains the token" is
//     trivially true when nothing was logged at all, so every such assertion
//     here is paired with `expectRedactedLogPresent`, which demands that a line
//     was emitted AND redacted. It also only works through
//     `workerWithLogCapture()` / `fetchDrained()`: `SELF` dispatches to a
//     SEPARATE isolate, so a test-side console spy cannot see its output, and
//     hono binds `console.log` as a default parameter at module-evaluation time.
//
// (b) A DISTINCT `cf-connecting-ip` PER REQUEST via `nextIp()`. `rateLimit()`
//     falls back to `ip = "0"`, so header-less requests share one
//     `rl:0:<minute>` bucket. Property 2 issues ~12 writes per generated case,
//     so a shared bucket would produce spurious 429s.
//
// The D3 properties additionally choose their addresses EXPLICITLY rather than
// via nextIp(), because the reporter GROUP (/64 or /24) is the input under test.
import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { captureLogs, expectRedactedLogPresent, fetchDrained, nextIp } from "./helpers.js";
import { arbContentCase, arbTokenMutation, fcParams, nextName, RUNS_FORGED, RUNS_HEAVY } from "./arbitraries.js";
import { ABUSE_AUTO_QUARANTINE, QUARANTINE_MAX_TTL_SEC } from "../src/constants.js";

const APEX = "https://0g.hk";

function jsonHeaders(ip: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", accept: "application/json", "cf-connecting-ip": ip, ...extra };
}

async function create(name: string, content: string): Promise<string> {
  const res = await SELF.fetch(`${APEX}/`, {
    method: "POST",
    headers: jsonHeaders(nextIp()),
    body: JSON.stringify({ name, content }),
    redirect: "manual",
  });
  const j: any = await res.json();
  if (!j.editToken) throw new Error(`create failed for ${name}: ${res.status} ${JSON.stringify(j)}`);
  return j.editToken as string;
}

async function raw(name: string): Promise<string> {
  const res = await SELF.fetch(`https://${name}.0g.hk/raw`, { headers: { "cf-connecting-ip": nextIp() } });
  return res.text();
}

async function kvNum(key: string): Promise<number> {
  const raw = await env.NOTES.get(key);
  return parseInt(raw || "0", 10) || 0;
}

/** POST /abuse/report from a CHOSEN source address — the address is the input. */
async function report(name: string, ip: string, body: Record<string, any> = {}): Promise<Response> {
  return SELF.fetch(`https://${name}.0g.hk/abuse/report`, {
    method: "POST",
    headers: jsonHeaders(ip),
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

/** Run `fn` with TURNSTILE_SECRET set, restoring whatever was there before. */
async function withTurnstileSecret<T>(secret: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = (env as any).TURNSTILE_SECRET;
  if (secret === undefined) delete (env as any).TURNSTILE_SECRET;
  else (env as any).TURNSTILE_SECRET = secret;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete (env as any).TURNSTILE_SECRET;
    else (env as any).TURNSTILE_SECRET = prev;
  }
}

// ===========================================================================
// Property 2 — transport equivalence
// ===========================================================================

describe("Property 2: transport equivalence (2.3, 2.4, 3.4)", () => {
  // design.md: "for each (content, ttl, renew), create three notes and edit one
  // via header, one via body, one via query; assert equal status and equal /raw
  // bytes across the three."
  //
  // This is the property that makes the deprecated `?edit=` form safe to keep:
  // it is not a second code path, it is a third spelling of the same one.
  it("header, body and query transports produce the same status and the same stored bytes", async () => {
    await fc.assert(
      fc.asyncProperty(arbContentCase, async ({ content, ttl, renew }) => {
        const patch: Record<string, any> = { content, ...(ttl ? { ttl } : {}), ...(renew ? { renew: true } : {}) };

        const names = [nextName("p2h"), nextName("p2b"), nextName("p2q")];
        const tokens = await Promise.all(names.map((n) => create(n, "original content")));

        // 1. header transport (the new one)
        const viaHeader = await SELF.fetch(`https://${names[0]}.0g.hk/`, {
          method: "POST",
          headers: jsonHeaders(nextIp(), { "x-edit-token": tokens[0] }),
          body: JSON.stringify(patch),
          redirect: "manual",
        });
        // 2. body transport (unchanged)
        const viaBody = await SELF.fetch(`https://${names[1]}.0g.hk/`, {
          method: "POST",
          headers: jsonHeaders(nextIp()),
          body: JSON.stringify({ token: tokens[1], ...patch }),
          redirect: "manual",
        });
        // 3. deprecated query transport
        const q = new URLSearchParams({ edit: tokens[2], c: content, ...(ttl ? { ttl } : {}), ...(renew ? { renew: "1" } : {}) });
        const viaQuery = await SELF.fetch(`https://${names[2]}.0g.hk/?${q}`, {
          method: "POST",
          headers: { accept: "application/json", "cf-connecting-ip": nextIp() },
          redirect: "manual",
        });

        const statuses = [viaHeader.status, viaBody.status, viaQuery.status];
        await Promise.all([viaHeader.text(), viaBody.text(), viaQuery.text()]);
        expect(new Set(statuses).size, `statuses diverged: ${JSON.stringify(statuses)}`).toBe(1);
        expect(statuses[0], "all three transports must succeed for creatable content").toBe(200);

        const bodies = await Promise.all(names.map(raw));
        expect(new Set(bodies).size, "stored bytes diverged across transports").toBe(1);
      }),
      fcParams(RUNS_HEAVY),
    );
  });

  // 2.3: only the DEPRECATED query form may mutate on a GET. A GET carrying the
  // header must stay a plain read — which is also what F did (it ignored the
  // header entirely), so this is preservation as much as it is policy.
  it("a GET carrying only X-Edit-Token performs a plain read and mutates nothing", async () => {
    const name = nextName("p2get");
    const token = await create(name, "must not change");

    const res = await SELF.fetch(`https://${name}.0g.hk/?format=json`, {
      headers: { accept: "application/json", "cf-connecting-ip": nextIp(), "x-edit-token": token },
      redirect: "manual",
    });
    const j: any = await res.json();
    expect(res.status).toBe(200);
    expect(j.content, "a GET is a read: the stored content comes back untouched").toBe("must not change");
    expect(await raw(name)).toBe("must not change");
  });

  // The one remaining place a token may legitimately appear in a URL is the
  // editor link's FRAGMENT, which browsers never transmit. Everything else must
  // be clean, and the deprecated form must be redacted.
  it("no transport leaks the token into a log line, and the deprecated form is redacted", async () => {
    const name = nextName("p2log");
    const token = await create(name, "log hygiene");

    for (const [label, init] of [
      ["header POST", { method: "POST", headers: jsonHeaders(nextIp(), { "x-edit-token": token }), body: JSON.stringify({ content: "via header" }) }],
      ["body POST", { method: "POST", headers: jsonHeaders(nextIp()), body: JSON.stringify({ token, content: "via body" }) }],
    ] as Array<[string, RequestInit]>) {
      const cap = captureLogs();
      try {
        const res = await fetchDrained(`https://${name}.0g.hk/`, init);
        expect(res.status, label).toBe(200);
        await res.text();
      } finally {
        cap.restore();
      }
      const leaking = cap.lines.filter((l) => l.includes(token));
      expect(leaking, `${label} leaked the token into: ${leaking.join(" | ")}`).toEqual([]);
    }

    // The deprecated query form: the token must be gone AND the line must show
    // that a token was presented. Without the second half this passes vacuously.
    const cap = captureLogs();
    try {
      const res = await fetchDrained(
        `https://${name}.0g.hk/?edit=${encodeURIComponent(token)}&c=${encodeURIComponent("via query")}`,
        { headers: { accept: "application/json", "cf-connecting-ip": nextIp() } },
      );
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      cap.restore();
    }
    expect(cap.lines.filter((l) => l.includes(token))).toEqual([]);
    expectRedactedLogPresent(cap.lines);
  });
});

// ===========================================================================
// Property 3 — no forged token authenticates
// ===========================================================================

describe("Property 3: no forged token authenticates (3.5)", () => {
  // The three transports must not merely agree on the happy path; they must
  // agree on REJECTION too, or the new header would be a weaker door.
  it("a mutated token is rejected on every transport, and the note is unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(arbTokenMutation, async ({ mutant, expectMissingToken }) => {
        const original = "forged-token-probe";
        const name = nextName("p3");
        await create(name, original);

        const expectedStatus = expectMissingToken ? 400 : 403;
        const expectedCode = expectMissingToken ? "missing_token" : "invalid_token";

        // header
        const h = await SELF.fetch(`https://${name}.0g.hk/`, {
          method: "POST",
          headers: jsonHeaders(nextIp(), mutant ? { "x-edit-token": mutant } : {}),
          body: JSON.stringify({ content: "should not land" }),
          redirect: "manual",
        });
        const hj: any = await h.json();
        expect({ t: "header", status: h.status, code: hj?.error?.code }).toEqual({ t: "header", status: expectedStatus, code: expectedCode });

        // body
        const b = await SELF.fetch(`https://${name}.0g.hk/`, {
          method: "POST",
          headers: jsonHeaders(nextIp()),
          body: JSON.stringify({ token: mutant, content: "should not land" }),
          redirect: "manual",
        });
        const bj: any = await b.json();
        expect({ t: "body", status: b.status, code: bj?.error?.code }).toEqual({ t: "body", status: expectedStatus, code: expectedCode });

        // deprecated query
        const q = await SELF.fetch(
          `https://${name}.0g.hk/?edit=${encodeURIComponent(mutant)}&c=nope`,
          { method: "POST", headers: { accept: "application/json", "cf-connecting-ip": nextIp() }, redirect: "manual" },
        );
        const qj: any = await q.json();
        expect({ t: "query", status: q.status, code: qj?.error?.code }).toEqual({ t: "query", status: expectedStatus, code: expectedCode });

        expect(await raw(name), "a forged token must never change the stored bytes").toBe(original);
      }),
      fcParams(RUNS_FORGED),
    );
  });
});

// ===========================================================================
// Property 7 — sub-threshold reports never disable
// ===========================================================================

describe("Property 7: sub-threshold reports never disable (2.14)", () => {
  // n DISTINCT reporter groups, all below the threshold. The old code disabled a
  // note at 3 reports; the new threshold is 10 DISTINCT /64s, so 9 must still
  // leave the note fully readable.
  it.each([1, 5, 9])("%i distinct reporter groups leave the note readable", async (n) => {
    const name = nextName("p7");
    await create(name, "https://untrusted.example/reported");

    for (let i = 0; i < n; i++) {
      // A distinct /64 per reporter: the group is what counts, so vary group 4.
      const res = await report(name, `2001:db8:7:${(i + 1).toString(16)}::1`);
      expect(res.status, `report ${i} must be accepted`).toBe(200);
      await res.text();
    }

    expect(await kvNum(`abuse:${name}`), `abuse:${name} must equal the ${n} distinct groups`).toBe(n);
    expect(await env.NOTES.get(`d:${name}`), "no marker below the threshold").toBeNull();

    const read = await SELF.fetch(`https://${name}.0g.hk/`, {
      headers: { accept: "text/html", "cf-connecting-ip": nextIp() },
      redirect: "manual",
    });
    await read.text();
    expect(read.status, "the note must stay readable").not.toBe(410);
  });
});

// ===========================================================================
// Property 9 — unverified reports are inert
// ===========================================================================

describe("Property 9: unverified reports are inert (2.12, 2.13, 2.18)", () => {
  it("with TURNSTILE_SECRET unset the report is accepted and counted (2.13)", async () => {
    const name = nextName("p9open");
    await create(name, "https://untrusted.example/x");
    await withTurnstileSecret(undefined, async () => {
      const res = await report(name, "203.0.113.11");
      const j: any = await res.json();
      expect({ status: res.status, reports: j.reports }).toEqual({ status: 200, reports: 1 });
    });
    expect(await kvNum(`abuse:${name}`)).toBe(1);
  });

  it("with TURNSTILE_SECRET set and no challenge token the report is fully inert", async () => {
    const name = nextName("p9closed");
    await create(name, "https://untrusted.example/y");
    const before = await kvNum(`abuse:${name}`);

    await withTurnstileSecret("p9-secret-never-dialled", async () => {
      const res = await report(name, "203.0.113.12"); // no turnstile field
      const j: any = await res.json();
      expect({ status: res.status, code: j?.error?.code }).toEqual({ status: 403, code: "challenge_failed" });
      expect(j.error.details.reason, "verifyTurnstile short-circuits on a missing token").toBe("missing");
    });

    expect(await kvNum(`abuse:${name}`), "the counter must not have moved").toBe(before);
    expect(await env.NOTES.get(`d:${name}`)).toBeNull();
    // And the reporter group's one dedupe slot must NOT have been burned, or a
    // rejected report would silently cost a legitimate one.
    await withTurnstileSecret(undefined, async () => {
      const res = await report(name, "203.0.113.12");
      const j: any = await res.json();
      expect({ status: res.status, deduped: j.deduped, reports: j.reports }).toEqual({ status: 200, deduped: false, reports: before + 1 });
    });
  });

  it("a present-but-unverifiable token is REJECTED here, not waved through", async () => {
    // Worth pinning precisely, because the code and the environment disagree
    // about which branch runs.
    //
    // `verifyTurnstile` has a deliberate fail-OPEN in its catch block: if the
    // call to challenges.cloudflare.com THROWS, it returns {ok:true}, so a
    // Cloudflare outage cannot silence abuse reporting. I assumed the sandbox
    // (no outbound network) would exercise that path. It does not: the request
    // comes back as a RESPONSE rather than an exception, `j.success` is falsy,
    // and the report is rejected with 403 `challenge_failed`.
    //
    // So the fail-open branch exists but is NOT reachable from this test
    // environment, and the effective behavior here is the stricter one. The
    // assertion records what is actually observable rather than the branch I
    // expected; the fail-open path itself would need a stubbed global fetch
    // inside the Worker isolate to exercise, which is out of scope.
    const name = nextName("p9unverifiable");
    await create(name, "https://untrusted.example/z");
    const before = await kvNum(`abuse:${name}`);

    await withTurnstileSecret("p9-secret-unreachable", async () => {
      const res = await report(name, "203.0.113.13", { turnstile: "a-token-that-cannot-be-verified" });
      const j: any = await res.json();
      expect(res.status, "an unverifiable challenge must not be waved through").toBe(403);
      expect(j.error.code).toBe("challenge_failed");
    });

    // Inert either way: whichever branch runs, a rejected report must not count.
    expect(await kvNum(`abuse:${name}`)).toBe(before);
    expect(await env.NOTES.get(`d:${name}`)).toBeNull();
  });
});

// ===========================================================================
// Property 10 — the automatic action is reversible and bounded
// ===========================================================================

describe("Property 10: the auto action is reversible and bounded (2.15, 2.16, 3.13)", () => {
  it("the quarantine marker is bounded, surfaces its expiry, and /admin/enable clears it", async () => {
    const name = nextName("p10");
    await create(name, "https://untrusted.example/quarantine");

    // Drive the counter to the threshold from ABUSE_AUTO_QUARANTINE distinct /64s.
    let last: any = null;
    for (let i = 0; i < ABUSE_AUTO_QUARANTINE; i++) {
      const res = await report(name, `2001:db8:10:${(i + 1).toString(16)}::1`);
      expect(res.status, `report ${i}`).toBe(200);
      last = await res.json();
    }
    expect(last.reports).toBe(ABUSE_AUTO_QUARANTINE);
    expect(last.disabled, "the threshold report must report the auto action").toBe(true);

    // BOUNDED: `exp` is inside the payload because KV does not expose a record's
    // remaining TTL on read — it is the only way the bound is observable.
    const marker = JSON.parse((await env.NOTES.get(`d:${name}`))!);
    expect(marker.auto, "the marker must be flagged automatic").toBe(true);
    expect(marker.reason).toBe("community_reports");
    expect(marker.exp - marker.at, "the marker may not outlive the longest note TTL").toBeLessThanOrEqual(
      QUARANTINE_MAX_TTL_SEC * 1000,
    );
    expect(marker.exp).toBeGreaterThan(marker.at);

    // The 410 contract is unchanged, and an auto marker additionally surfaces
    // when it lifts by itself (2.16).
    const jsonRead = await SELF.fetch(`https://${name}.0g.hk/?format=json`, {
      headers: { accept: "application/json", "cf-connecting-ip": nextIp() },
      redirect: "manual",
    });
    const jr: any = await jsonRead.json();
    expect({ status: jsonRead.status, code: jr.error.code }).toEqual({ status: 410, code: "disabled" });
    expect(jr.error.details.auto).toBe(true);
    expect(jr.error.details.until).toBe(new Date(marker.exp).toISOString());

    const htmlRead = await SELF.fetch(`https://${name}.0g.hk/`, {
      headers: { accept: "text/html", "cf-connecting-ip": nextIp() },
      redirect: "manual",
    });
    const body = await htmlRead.text();
    expect(htmlRead.status).toBe(410);
    expect(body, "the owner must be told this is temporary").toContain("临时隔离");
    expect(body, "and given the appeal route").toContain("abuse@0g.hk");

    // REVERSIBLE: /admin/enable clears both keys, exactly as it did for an
    // admin-issued disable (3.13).
    const ADMIN_KEY = "p10-admin-key";
    const prev = (env as any).ADMIN_KEY;
    (env as any).ADMIN_KEY = ADMIN_KEY;
    try {
      const en = await SELF.fetch(`${APEX}/admin/enable?name=${name}`, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${ADMIN_KEY}` },
        redirect: "manual",
      });
      expect(en.status).toBe(200);
      await en.text();
    } finally {
      if (prev === undefined) delete (env as any).ADMIN_KEY;
      else (env as any).ADMIN_KEY = prev;
    }

    expect(await env.NOTES.get(`d:${name}`), "/admin/enable must clear the marker").toBeNull();
    expect(await env.NOTES.get(`abuse:${name}`), "and the counter").toBeNull();

    const after = await SELF.fetch(`https://${name}.0g.hk/?format=json`, {
      headers: { accept: "application/json", "cf-connecting-ip": nextIp() },
      redirect: "manual",
    });
    await after.text();
    expect(after.status, "the note must be readable again").not.toBe(410);
  });

  it("one reporter group can never reach the threshold, however many requests it sends", async () => {
    // The C3 input, generalized: ABUSE_AUTO_QUARANTINE requests from addresses
    // that all sit in ONE /64 must count once and never quarantine.
    const name = nextName("p10one");
    await create(name, "https://untrusted.example/single-actor");

    for (let i = 0; i < ABUSE_AUTO_QUARANTINE + 2; i++) {
      const res = await report(name, `2001:db8:cafe:1::${(i + 1).toString(16)}`);
      expect(res.status).toBe(200);
      const j: any = await res.json();
      expect(j.reports, "one group counts once").toBe(1);
      expect(j.deduped, `request ${i} deduped flag`).toBe(i > 0);
    }
    expect(await kvNum(`abuse:${name}`)).toBe(1);
    expect(await env.NOTES.get(`d:${name}`)).toBeNull();
  });
});
