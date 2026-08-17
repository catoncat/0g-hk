import { describe, it, expect, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { ctEq, makeBackground } from "../src/util.js";

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
