import { describe, it, expect, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import fc from "fast-check";
import { ctEq, makeBackground, isUrl, resolveKind, readKind } from "../src/util.js";
import { arbBoundaryContent, fcParams, RUNS_PURE } from "./arbitraries.js";

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
