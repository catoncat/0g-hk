import { describe, it, expect, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import fc from "fast-check";
import { ctEq, makeBackground, isUrl, resolveKind, readKind, redactLogLine, reporterGroup } from "../src/util.js";
// The quarantine TTL helpers live in src/index.ts (design.md puts them next to
// their only caller, handleAbuseReport), so this one import reaches past
// src/util.js. It resolves to the SAME module instance the pool already
// evaluated as the Worker entry — no re-evaluation, and no interference with
// SELF, which is why it is imported plainly rather than with the `?logspy=1`
// cache-busting query test/helpers.ts needs.
import { remainingNoteTtlSec, quarantineTtlSec } from "../src/index.js";
import { QUARANTINE_MAX_TTL_SEC, QUARANTINE_MIN_TTL_SEC, TTL_OPTIONS } from "../src/constants.js";
import {
  arbAddressForms,
  arbBoundaryContent,
  arbDifferentRangePair,
  arbQueryString,
  arbSameRangePair,
  fcParams,
  RUNS_PURE,
} from "./arbitraries.js";

describe("ctEq", () => {
  it("returns true for equal strings", () => {
    expect(ctEq("hello", "hello")).toBe(true);
    expect(ctEq("", "")).toBe(true);
    expect(ctEq("a", "a")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(ctEq("hello", "world")).toBe(false);
    expect(ctEq("abc", "abd")).toBe(false);
    expect(ctEq("abc", "axc")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(ctEq("hello", "helloo")).toBe(false);
    expect(ctEq("helloo", "hello")).toBe(false);
    expect(ctEq("a", "")).toBe(false);
    expect(ctEq("", "a")).toBe(false);
  });

  it("returns false for non-string inputs", () => {
    expect(ctEq(null, "hello")).toBe(false);
    expect(ctEq("hello", null)).toBe(false);
    expect(ctEq(undefined, undefined)).toBe(false);
    expect(ctEq(123, 123)).toBe(false);
    expect(ctEq({}, {})).toBe(false);
  });

  it("handles special characters and unicode", () => {
    expect(ctEq("!@#$%^&*()", "!@#$%^&*()")).toBe(true);
    expect(ctEq("\u4f60\u597d", "\u4f60\u597d")).toBe(true);
    expect(ctEq("\u4f60\u597d", "\u4f60\u597d\u5417")).toBe(false);
    expect(ctEq("\u{1f680}", "\u{1f680}")).toBe(true);
    expect(ctEq("\u{1f680}", "\u{1f6f8}")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// makeBackground (task 4.1, design.md *Unit Tests*)
//
// The facade has exactly two modes, and both are exercised here:
//   - a real ExecutionContext  -> the runtime owns the promise, settle() is a no-op
//   - null / no waitUntil      -> the facade owns the promise, settle() awaits it
// In both modes a rejecting promise must never propagate outward, because the
// only caller is telemetry and telemetry may not break a response.
describe("makeBackground", () => {
  /** Resolves to "settled" if `p` wins the race, "timeout" if it does not. */
  function raceTimeout(p: Promise<unknown>, ms = 50) {
    return Promise.race([
      p.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("timeout"), ms)),
    ]);
  }

  describe("with a real ExecutionContext", () => {
    it("hands every promise to ctx.waitUntil", async () => {
      const ctx = createExecutionContext();
      const spy = vi.spyOn(ctx, "waitUntil");
      const bg = makeBackground(ctx);

      let done = false;
      bg.waitUntil(Promise.resolve().then(() => { done = true; }));
      bg.waitUntil(Promise.resolve("second"));

      expect(spy).toHaveBeenCalledTimes(2);
      // The forwarded value is a thenable (the wrapper around the caller's promise).
      expect(typeof (spy.mock.calls[0][0] as any).then).toBe("function");

      // The runtime, not the facade, is what keeps the work alive.
      await waitOnExecutionContext(ctx);
      expect(done).toBe(true);
    });

    it("settle() resolves immediately, without waiting for the work", async () => {
      const ctx = createExecutionContext();
      const bg = makeBackground(ctx);
      let resolveWork: () => void = () => {};
      bg.waitUntil(new Promise<void>((r) => { resolveWork = r; }));

      // The queued promise is still pending, yet settle() must not block on it.
      expect(await raceTimeout(bg.settle())).toBe("settled");

      resolveWork();
      await waitOnExecutionContext(ctx);
    });

    it("a rejecting promise never propagates out of the ctx path", async () => {
      const ctx = createExecutionContext();
      const spy = vi.spyOn(ctx, "waitUntil");
      const bg = makeBackground(ctx);

      bg.waitUntil(Promise.reject(new Error("kv write failed")));

      // What the runtime receives must already be a resolved-only promise,
      // otherwise waitOnExecutionContext (and the real runtime) would see it.
      await expect(spy.mock.calls[0][0] as Promise<unknown>).resolves.toBeUndefined();
      await expect(bg.settle()).resolves.toBeUndefined();
      await waitOnExecutionContext(ctx);
    });
  });

  describe("with null", () => {
    it("settle() awaits the queued promises", async () => {
      const bg = makeBackground(null);
      const order: string[] = [];
      bg.waitUntil(new Promise<void>((r) => setTimeout(() => { order.push("a"); r(); }, 10)));
      bg.waitUntil(new Promise<void>((r) => setTimeout(() => { order.push("b"); r(); }, 20)));

      expect(order).toEqual([]); // nothing has run yet
      await bg.settle();
      expect(order).toEqual(["a", "b"]);
    });

    it("settle() with nothing queued resolves, and drains what it awaited", async () => {
      const bg = makeBackground(null);
      await expect(bg.settle()).resolves.toBeUndefined();

      let runs = 0;
      bg.waitUntil(Promise.resolve().then(() => { runs++; }));
      await bg.settle();
      expect(runs).toBe(1);

      // Second settle sees an empty queue: it neither re-runs nor blocks.
      expect(await raceTimeout(bg.settle())).toBe("settled");
      expect(runs).toBe(1);
    });

    it("a rejecting promise never propagates out of settle()", async () => {
      const bg = makeBackground(null);
      let ok = false;
      bg.waitUntil(Promise.reject(new Error("kv write failed")));
      bg.waitUntil(Promise.resolve().then(() => { ok = true; }));

      await expect(bg.settle()).resolves.toBeUndefined();
      expect(ok).toBe(true); // one failure does not cancel the rest
    });

    it("falls back to the queue when the context has no waitUntil", async () => {
      for (const noCtx of [undefined, {}, { waitUntil: null }] as any[]) {
        const bg = makeBackground(noCtx);
        let done = false;
        bg.waitUntil(new Promise<void>((r) => setTimeout(() => { done = true; r(); }, 5)));
        await bg.settle();
        expect(done).toBe(true);
      }
    });

    it("accepts a non-promise value", async () => {
      const bg = makeBackground(null);
      bg.waitUntil("not a promise");
      await expect(bg.settle()).resolves.toBeUndefined();
    });
  });
});


// ---------------------------------------------------------------------------
// resolveKind / readKind (task 5.1, design.md *Unit Tests*)
//
// These two helpers replace five independent `isUrl(content)` derivations, so
// the properties that matter are:
//   1. resolveKind IS isUrl, renamed — never a second opinion.
//   2. readKind honours a persisted k ONLY when it is exactly "url"/"text";
//      anything else (corrupt, unknown, missing, or a meta that is not even an
//      object) degrades to resolveKind, i.e. to today's behavior.
// The corrupt cases are the load-bearing ones: a truthiness check would have
// accepted "URL" and 1 and produced an undefined branch downstream.
describe("resolveKind", () => {
  it("classifies URLs as \"url\"", () => {
    for (const c of [
      "https://example.com",
      "http://example.com/a/b?q=1",
      "docs.example.com",
      "example.com:8080/path",
      "EXAMPLE.COM",
    ]) {
      expect(resolveKind(c), c).toBe("url");
    }
  });

  it("classifies everything else as \"text\"", () => {
    for (const c of [
      "hello world",
      "just-a-word",
      "example.com with trailing words",
      "javascript:alert(1)",
      "example.com.", // trailing dot fails URL_NO_SCHEME_RE
      "",
    ]) {
      expect(resolveKind(c), JSON.stringify(c)).toBe("text");
    }
  });

  it("agrees with isUrl exactly, including on non-string input", () => {
    for (const c of ["https://a.example", "hi there", "", null, undefined, 0, 123, {}, []] as any[]) {
      expect(resolveKind(c), JSON.stringify(c)).toBe(isUrl(c) ? "url" : "text");
    }
  });
});

describe("readKind", () => {
  const meta = (k?: unknown) => (k === undefined ? { v: 1, t: "7d" } : { v: 1, t: "7d", k });

  it("returns the persisted k when it is valid, even against the content", () => {
    // The persisted kind is authoritative: a note stored as text stays text
    // even if its current content happens to look like a URL, and vice versa.
    expect(readKind(meta("url"), "https://example.com")).toBe("url");
    expect(readKind(meta("text"), "hello world")).toBe("text");
    expect(readKind(meta("text"), "docs.example.com")).toBe("text");
    expect(readKind(meta("url"), "hello world")).toBe("url");
  });

  it("falls back when k is present but corrupt", () => {
    // Wrong case, wrong type, and null are each rejected by the two-literal
    // guard, so the note behaves exactly as it did before k existed.
    for (const bad of ["URL", "Url", "TEXT", "text ", " url", 1, 0, null, true, false, {}, [], ["url"], { k: "url" }] as any[]) {
      expect(readKind(meta(bad), "https://example.com"), JSON.stringify(bad)).toBe("url");
      expect(readKind(meta(bad), "hello world"), JSON.stringify(bad)).toBe("text");
    }
  });

  it("falls back when k is absent — the legacy record case", () => {
    expect(readKind(meta(), "https://example.com")).toBe("url");
    expect(readKind(meta(), "docs.example.com")).toBe("url");
    expect(readKind(meta(), "hello world")).toBe("text");
    expect(readKind({}, "hello world")).toBe("text");
    expect(readKind({ k: undefined } as any, "docs.example.com")).toBe("url");
  });

  it("falls back when meta is null or undefined", () => {
    // Callers pass whatever JSON.parse gave them, and a corrupt-meta read
    // yields null — probing `.k` on it must not throw.
    expect(readKind(null, "https://example.com")).toBe("url");
    expect(readKind(null, "hello world")).toBe("text");
    expect(readKind(undefined, "docs.example.com")).toBe("url");
    expect(readKind(undefined, "hello world")).toBe("text");
  });

  it("falls back when meta is not an object at all", () => {
    for (const shape of ["url", "text", 0, 1, "", true, [], [1, 2], NaN] as any[]) {
      expect(readKind(shape, "https://example.com"), JSON.stringify(shape)).toBe("url");
      expect(readKind(shape, "hello world"), JSON.stringify(shape)).toBe("text");
    }
  });

  it("the fallback equals isUrl(content) exactly", () => {
    // Every no-valid-k shape must produce the pre-fix answer for the same
    // content — this is the 2.21 legacy guarantee stated as an equality.
    const noKind: any[] = [null, undefined, {}, { k: undefined }, { k: "URL" }, { k: 1 }, { k: null }, "not-an-object"];
    const contents: any[] = [
      "https://example.com",
      "http://a.b/c?d=e",
      "docs.example.com",
      "a.co:65535/x",
      "hello world",
      "example.com.",
      "-bad.example.com",
      "",
      null,
      undefined,
      42,
    ];
    for (const m of noKind) {
      for (const c of contents) {
        expect(readKind(m, c), `${JSON.stringify(m)} / ${JSON.stringify(c)}`).toBe(isUrl(c) ? "url" : "text");
      }
    }
  });

  it("the fallback equals isUrl(content) across generated boundary content", () => {
    // arbBoundaryContent straddles URL_NO_SCHEME_RE, which is where a
    // hand-written table is weakest; the claim is the same equality.
    fc.assert(
      fc.property(arbBoundaryContent, ({ content, category }) => {
        const expected = isUrl(content) ? "url" : "text";
        expect(resolveKind(content), category).toBe(expected);
        for (const m of [null, undefined, {}, { k: "URL" }, { k: 1 }, { k: null }] as any[]) {
          expect(readKind(m, content), `${category} / ${JSON.stringify(m)}`).toBe(expected);
        }
        // A valid persisted kind always wins, whichever side of the boundary
        // the content happens to fall on.
        expect(readKind({ k: "url" }, content), category).toBe("url");
        expect(readKind({ k: "text" }, content), category).toBe("text");
      }),
      fcParams(RUNS_PURE),
    );
  });
});


// ---------------------------------------------------------------------------
// redactLogLine (task 6.2, design.md *Unit Tests* + Property 1)
//
// The function is one `String.replace`, so what is worth testing is the REGEX's
// boundaries, not the plumbing:
//   - all four secret parameter names, in every position a query string offers;
//   - the parameter NAME survives while the value goes (this is what makes "no
//     token in the logs" a checkable claim rather than a vacuous one);
//   - non-secret parameters are byte-identical, including values containing
//     "=", percent-escapes, colons, slashes and spaces;
//   - it is idempotent and total (empty, null, non-string).
// ---------------------------------------------------------------------------
describe("redactLogLine", () => {
  const TOKEN = "Zm9vYmFyLXNlY3JldC0x"; // a genToken()-shaped value

  it("redacts each secret parameter name", () => {
    for (const name of ["edit", "token", "key", "ts"]) {
      expect(redactLogLine(`<-- GET /?${name}=${TOKEN}`)).toBe(`<-- GET /?${name}=[redacted]`);
    }
  });

  it("redacts a secret in any position, and every occurrence", () => {
    // First parameter (the `?` branch of [?&]).
    expect(redactLogLine(`<-- GET /?edit=${TOKEN}&c=hello`)).toBe("<-- GET /?edit=[redacted]&c=hello");
    // Middle and last (the `&` branch).
    expect(redactLogLine(`<-- GET /?c=hello&edit=${TOKEN}&ttl=1h`)).toBe("<-- GET /?c=hello&edit=[redacted]&ttl=1h");
    expect(redactLogLine(`<-- GET /?c=hello&edit=${TOKEN}`)).toBe("<-- GET /?c=hello&edit=[redacted]");
    // Repeated, and mixed names — a non-global regex would only catch the first.
    expect(redactLogLine(`<-- GET /?edit=${TOKEN}&c=x&token=${TOKEN}&key=adm&ts=chal`)).toBe(
      "<-- GET /?edit=[redacted]&c=x&token=[redacted]&key=[redacted]&ts=[redacted]",
    );
  });

  it("keeps the parameter name, and stops at whitespace", () => {
    // hono's outgoing line is `--> GET /path 200 3ms`: the value must end at the
    // space, not eat the status and timing.
    expect(redactLogLine(`--> GET /?edit=${TOKEN} 200 3ms`)).toBe("--> GET /?edit=[redacted] 200 3ms");
    expect(redactLogLine(`<-- GET /admin/stats?key=${TOKEN}`)).toContain("key=[redacted]");
    expect(redactLogLine(`<-- GET /admin/stats?key=${TOKEN}`)).not.toContain(TOKEN);
  });

  it("is case-insensitive on the name but preserves its casing", () => {
    expect(redactLogLine(`<-- GET /?EDIT=${TOKEN}`)).toBe("<-- GET /?EDIT=[redacted]");
    expect(redactLogLine(`<-- GET /?Token=${TOKEN}`)).toBe("<-- GET /?Token=[redacted]");
  });

  it("leaves non-secret parameters byte-identical", () => {
    const line =
      "<-- POST /?c=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc&n=my-note&ttl=1h&format=json";
    expect(redactLogLine(line)).toBe(line);
    // Values carrying "=", ":", "/" and a raw space are untouched too.
    for (const v of ["eq=inside=value", "1.2.3.4:8080/p=q", "raw space value", "%E4%B8%AD%E6%96%87"]) {
      expect(redactLogLine(`<-- GET /?c=${v}`)).toBe(`<-- GET /?c=${v}`);
    }
  });

  it("does not redact a secret name that is not a query parameter", () => {
    // No [?&] in front: a path segment or a bare word must not be rewritten.
    expect(redactLogLine("<-- GET /edit=notaparam")).toBe("<-- GET /edit=notaparam");
    expect(redactLogLine("unhandled Error: token=abc")).toBe("unhandled Error: token=abc");
  });

  it("is idempotent", () => {
    const once = redactLogLine(`<-- GET /?edit=${TOKEN}&c=x&key=${TOKEN}`);
    expect(redactLogLine(once)).toBe(once);
    expect(redactLogLine(redactLogLine(once))).toBe(once);
  });

  it("is total: empty, whitespace and non-string input", () => {
    expect(redactLogLine("")).toBe("");
    expect(redactLogLine(null)).toBe("");
    expect(redactLogLine(undefined)).toBe("");
    expect(redactLogLine(42 as any)).toBe("42");
    expect(redactLogLine({ a: 1 } as any)).toBe("[object Object]");
    expect(redactLogLine(["?edit=" + TOKEN] as any)).toBe("?edit=[redacted]");
  });

  // Property 1: Bug Condition — token confidentiality.
  //
  // The claim is stated as an EXACT rewrite rather than as three weaker
  // substring checks. "The output never contains the token" is unsound as
  // written: arbToken can emit a single character, which a non-secret value like
  // "hello" contains by accident. The exact form ("every secret value became
  // [redacted], nothing else moved") is strictly stronger and has no such hole.
  it("Property 1: redacts every secret value and changes nothing else (PBT)", () => {
    fc.assert(
      fc.property(arbQueryString, (c) => {
        const out = redactLogLine(c.logLine);

        const expectedQuery =
          "?" + c.params.map((p) => `${p.name}=${p.secret ? "[redacted]" : p.value}`).join("&");
        expect(out, c.shape).toBe(c.logLine.replace(c.query, expectedQuery));

        // Non-vacuity: every generated case carries at least one secret, so a
        // redaction marker must be present.
        expect(out, c.shape).toContain("[redacted]");
        // The token no longer appears as the value of any secret parameter.
        for (const p of c.params.filter((p) => p.secret)) {
          expect(out, `${c.shape} / ${p.name}`).not.toContain(`${p.name}=${c.secret}`);
        }
        // Non-secret parameters survive byte for byte.
        for (const pair of c.nonSecretPairs) expect(out, c.shape).toContain(pair);
        // Idempotent on real input, not just on the hand-written cases.
        expect(redactLogLine(out), c.shape).toBe(out);
      }),
      fcParams(RUNS_PURE),
    );
  });
});

// ---------------------------------------------------------------------------
// reporterGroup (task 6.7, design.md *Unit Tests* + Property 8)
//
// The defect being closed: the old truncation was textual
// (`split(":").slice(0,4)…`), and IPv6 has several spellings per address, so
// `2001:db8::1` / `::2` / `::3` — one /64, one actor — hashed to three distinct
// dedupe keys and counted as three reporters. Every case below is therefore
// about CANONICALIZATION: same address in different notation ⇒ same group;
// different range ⇒ different group.
// ---------------------------------------------------------------------------
describe("reporterGroup", () => {
  it("collapses an IPv6 address to its /64", () => {
    expect(reporterGroup("2001:db8::1")).toBe("v6:2001:0db8:0000:0000");
    expect(reporterGroup("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("v6:2001:0db8:0000:0000");
    expect(reporterGroup("2001:db8:1:2:3:4:5:6")).toBe("v6:2001:0db8:0001:0002");
  });

  it("is stable across text forms of ONE address", () => {
    // Compressed, fully expanded, unpadded, uppercase, and with surrounding
    // whitespace — the shapes a real cf-connecting-ip can arrive in.
    const forms = [
      "2001:db8::1",
      "2001:0db8:0000:0000:0000:0000:0000:0001",
      "2001:db8:0:0:0:0:0:1",
      "2001:0DB8:0000:0000:0000:0000:0000:0001",
      "  2001:db8::1  ",
      "2001:DB8::1",
    ];
    const groups = forms.map(reporterGroup);
    expect(new Set(groups).size, JSON.stringify(groups)).toBe(1);
  });

  it("treats every address in one /64 as one reporter — the exact C3 input", () => {
    // bugfix.md 1.11 / exploratory case 5: these three used to be three
    // reporters, which is how a single actor reached the auto-action threshold.
    const g = ["2001:db8::1", "2001:db8:0:0::2", "2001:0db8:0000:0000:0000:0000:0000:0003", "2001:db8::4"].map(
      reporterGroup,
    );
    expect(new Set(g).size, JSON.stringify(g)).toBe(1);
  });

  it("distinguishes adjacent /64s", () => {
    expect(reporterGroup("2001:db8:0:1::1")).not.toBe(reporterGroup("2001:db8:0:2::1"));
    expect(reporterGroup("2001:db8::1")).not.toBe(reporterGroup("2001:db9::1"));
    // ...but not the low-order 64 bits, which are exactly what an actor varies.
    expect(reporterGroup("2001:db8::1")).toBe(reporterGroup("2001:db8:0:0:ffff:ffff:ffff:ffff"));
  });

  it("strips a zone id", () => {
    expect(reporterGroup("fe80::1%eth0")).toBe("v6:fe80:0000:0000:0000");
    expect(reporterGroup("fe80::1%eth0")).toBe(reporterGroup("fe80::2"));
    expect(reporterGroup("FE80:0000:0000:0000:0000:0000:0000:0001%42")).toBe("v6:fe80:0000:0000:0000");
  });

  it("folds an IPv4-mapped address, in dotted AND hex-group form", () => {
    // ::ffff:192.0.2.1 == ::ffff:c000:201 — the same address, two spellings.
    const mapped = ["::ffff:192.0.2.1", "::ffff:c000:201", "::FFFF:c000:0201", "::ffff:192.0.2.9"].map(reporterGroup);
    expect(new Set(mapped).size, JSON.stringify(mapped)).toBe(1);
    // Every mapped address lives in ::/64, so they all share one group.
    expect(reporterGroup("::ffff:192.0.2.1")).toBe("v6:0000:0000:0000:0000");
    expect(reporterGroup("::ffff:198.51.100.7")).toBe(reporterGroup("::ffff:192.0.2.1"));
  });

  it("expands :: to exactly eight groups, wherever it sits", () => {
    expect(reporterGroup("::")).toBe("v6:0000:0000:0000:0000");
    expect(reporterGroup("::1")).toBe("v6:0000:0000:0000:0000");
    expect(reporterGroup("2001:db8::")).toBe("v6:2001:0db8:0000:0000");
    expect(reporterGroup("2001::db8")).toBe("v6:2001:0000:0000:0000");
    expect(reporterGroup("1:2:3:4::5")).toBe("v6:0001:0002:0003:0004");
  });

  it("collapses an IPv4 address to its /24", () => {
    expect(reporterGroup("203.0.113.7")).toBe("v4:203.0.113");
    expect(reporterGroup("203.0.113.7")).toBe(reporterGroup("203.0.113.254"));
    expect(reporterGroup("198.51.100.1")).not.toBe(reporterGroup("198.51.101.1"));
    expect(reporterGroup(" 198.51.100.1\t")).toBe("v4:198.51.100");
  });

  it("never confuses the two families", () => {
    expect(reporterGroup("1.2.3.4")).not.toBe(reporterGroup("1:2:3:4::"));
    expect(reporterGroup("0.0.0.0")).not.toBe(reporterGroup("::"));
  });

  it("is total on empty and malformed input", () => {
    for (const empty of ["", "   ", "\t", null, undefined] as any[]) {
      expect(reporterGroup(empty), JSON.stringify(empty)).toBe("v0:unknown");
    }
    // rateLimit()'s header-less fallback value.
    expect(reporterGroup("0")).toBe("v4:0");
    // Nothing throws, and every answer is a stable string.
    for (const junk of [
      "not-an-ip",
      ":::",
      "gg:hh:ii",
      "1:2:3:4:5:6:7:8:9:10",
      "1.2.3.4.5",
      "::ffff:999.999.999.999",
      "1.2.3.4:8080",
      42,
      {},
    ] as any[]) {
      const g = reporterGroup(junk);
      expect(typeof g, JSON.stringify(junk)).toBe("string");
      expect(g, JSON.stringify(junk)).toBe(reporterGroup(junk));
    }
    // A dotted quad with a port is IPv4 with transport noise, not IPv6.
    expect(reporterGroup("1.2.3.4:8080")).toBe("v4:1.2.3");
  });

  // Property 8: Bug Condition — one address range counts once.
  //
  // Asserted as EQUALITY BETWEEN GROUPS, never against a literal format: the
  // generator's `refRangeKey` is the self-test's yardstick in
  // test/arbitraries.test.ts, not a promise about this function's output shape.
  it("Property 8: every text form of one address yields one group (PBT)", () => {
    fc.assert(
      fc.property(arbAddressForms, (a) => {
        const groups = a.forms.map(reporterGroup);
        expect(new Set(groups).size, `${a.family} ${a.canonical}: ${JSON.stringify(groups)}`).toBe(1);
        expect(groups[0].startsWith(a.family === "v4" ? "v4:" : "v6:"), a.canonical).toBe(true);
      }),
      fcParams(RUNS_PURE),
    );
  });

  it("Property 8: addresses in one range share a group, across all forms (PBT)", () => {
    fc.assert(
      fc.property(arbSameRangePair, ({ a, b }) => {
        const ga = reporterGroup(a.canonical);
        for (const f of a.forms.concat(b.forms)) {
          expect(reporterGroup(f), `${a.canonical} vs ${b.canonical} via ${f}`).toBe(ga);
        }
      }),
      fcParams(RUNS_PURE),
    );
  });

  it("Property 8: addresses in different ranges never share a group (PBT)", () => {
    fc.assert(
      fc.property(arbDifferentRangePair, ({ a, b }) => {
        for (const fa of a.forms) {
          for (const fb of b.forms) {
            expect(reporterGroup(fa), `${fa} vs ${fb}`).not.toBe(reporterGroup(fb));
          }
        }
      }),
      fcParams(RUNS_PURE),
    );
  });
});

// ---------------------------------------------------------------------------
// The quarantine TTL clamp (task 6.9, design.md *Unit Tests*)
//
// This is what replaces `expirationTtl: 365 * 86400` (1.13): the automatic
// marker lives for the note's OWN remaining lifetime, clamped into
// [QUARANTINE_MIN_TTL_SEC, QUARANTINE_MAX_TTL_SEC]. The clamp is the whole
// guarantee, so the last test states it as a universal over every shape the
// other tests feed in — including the degenerate ones.
// ---------------------------------------------------------------------------
describe("remainingNoteTtlSec / quarantineTtlSec", () => {
  const now = () => Date.now();
  const metaAt = (t: string, ageSec: number) => ({ v: 1, h: "x", t, ct: now() - ageSec * 1000 });

  /** remainingNoteTtlSec is computed against a live clock; allow a few ms. */
  const near = (actual: number, expected: number) => {
    expect(actual).toBeLessThanOrEqual(expected);
    expect(actual).toBeGreaterThan(expected - 5);
  };

  it("computes the note's remaining lifetime for each TTL option", () => {
    for (const t of Object.keys(TTL_OPTIONS)) {
      near(remainingNoteTtlSec(metaAt(t, 0)), TTL_OPTIONS[t]);
    }
    near(remainingNoteTtlSec(metaAt("7d", 6 * 86400)), 86400);
    near(remainingNoteTtlSec(metaAt("1d", 12 * 3600)), 12 * 3600);
    near(remainingNoteTtlSec(metaAt("1h", 30 * 60)), 30 * 60);
  });

  it("returns a non-positive number for an already-expired note", () => {
    expect(remainingNoteTtlSec(metaAt("1h", 2 * 3600))).toBeLessThan(0);
    expect(remainingNoteTtlSec(metaAt("7d", 30 * 86400))).toBeLessThan(0);
  });

  it("falls back to the maximum for missing meta", () => {
    for (const m of [null, undefined] as any[]) {
      expect(remainingNoteTtlSec(m), JSON.stringify(m)).toBe(QUARANTINE_MAX_TTL_SEC);
      expect(quarantineTtlSec(m), JSON.stringify(m)).toBe(QUARANTINE_MAX_TTL_SEC);
    }
  });

  it("falls back to the maximum for corrupt or partial meta", () => {
    // No `t`, an unknown `t`, a non-numeric / absent / nonsensical `ct`, and a
    // meta that is not an object at all. A note whose meta we cannot read must
    // not get an ARBITRARILY long marker, and must not get a zero one either.
    for (const m of [
      {},
      { t: "7d" },
      { ct: now() },
      { t: "9d", ct: now() },
      { t: "", ct: now() },
      { t: "7d", ct: "abc" },
      { t: "7d", ct: null },
      { t: "7d", ct: 0 },
      { t: "7d", ct: -1 },
      { t: "7d", ct: NaN },
      { t: "7d", ct: Infinity },
      "not-an-object",
      42,
      [],
      true,
    ] as any[]) {
      expect(remainingNoteTtlSec(m), JSON.stringify(m)).toBe(QUARANTINE_MAX_TTL_SEC);
    }
  });

  it("clamps the quarantine TTL into [min, max]", () => {
    // A fresh 7d note is already at the ceiling; a 1h note nearly gone is
    // lifted to the floor so KV never sees a zero/negative expirationTtl.
    expect(quarantineTtlSec(metaAt("7d", 0))).toBe(QUARANTINE_MAX_TTL_SEC);
    expect(quarantineTtlSec(metaAt("1h", 0))).toBe(QUARANTINE_MIN_TTL_SEC);
    expect(quarantineTtlSec(metaAt("1h", 59 * 60))).toBe(QUARANTINE_MIN_TTL_SEC);
    expect(quarantineTtlSec(metaAt("1h", 2 * 3600))).toBe(QUARANTINE_MIN_TTL_SEC);
    // In between, the note's own remaining lifetime is used verbatim.
    near(quarantineTtlSec(metaAt("7d", 6 * 86400)), 86400);
    near(quarantineTtlSec(metaAt("1d", 0)), 86400);
  });

  it("the clamp holds for every meta shape and age", () => {
    const shapes: any[] = [null, undefined, {}, { t: "7d" }, "junk", 0];
    for (const t of Object.keys(TTL_OPTIONS)) {
      for (const ageSec of [0, 1, 60, 3599, 3600, 86399, 86400, 6 * 86400, 7 * 86400, 400 * 86400]) {
        shapes.push(metaAt(t, ageSec));
      }
    }
    for (const m of shapes) {
      const ttl = quarantineTtlSec(m);
      expect(ttl, JSON.stringify(m)).toBeGreaterThanOrEqual(QUARANTINE_MIN_TTL_SEC);
      expect(ttl, JSON.stringify(m)).toBeLessThanOrEqual(QUARANTINE_MAX_TTL_SEC);
      // And the marker can never outlive the longest possible note.
      expect(ttl, JSON.stringify(m)).toBeLessThanOrEqual(TTL_OPTIONS["7d"]);
    }
  });
});
