import { describe, it, expect } from "vitest";
import { ctEq } from "../src/util.js";

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
