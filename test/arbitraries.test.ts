// Self-checks for the generators in test/arbitraries.ts.
//
// WHY A GENERATOR NEEDS ITS OWN TESTS
// ----------------------------------
// A property test is only as strong as its inputs. A generator that silently
// produced degenerate values — a "mutated" token equal to the original, a
// "same-range" address pair that is one address twice, boundary content that
// always answers 400 — would make the later security properties pass
// VACUOUSLY. These tests pin the non-obvious invariants so that can't happen
// quietly.
//
// The address checks use an INDEPENDENT reference parser (`refRange` below) that
// works TEXT → MODEL, the opposite direction from the generator's MODEL → TEXT
// rendering. Neither calls `reporterGroup`, which does not exist yet (task 6.7)
// — checking a generator against the function it is meant to test would be
// circular.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import baseline from "./__fixtures__/preservation-baseline.json";
import { isUrl, normalizeUrl, parseUrlSafe, isBlockedTargetHost, hasDangerousScheme, isBrandSquatting } from "../src/util.js";
import { NAME_RE, RESERVED, TEXT_MAX, URL_MAX } from "../src/constants.js";
import {
  FC_SEED,
  RUNS_PURE,
  PRESERVATION_SEED,
  PRESERVATION_NUM_RUNS,
  fcParams,
  arbToken,
  arbTokenMutation,
  TOKEN_MUTATION_KINDS,
  arbQueryString,
  SECRET_PARAMS,
  arbContent,
  arbContentCase,
  arbBoundaryContent,
  BOUNDARY_CATEGORIES,
  arbAddressForms,
  arbSameRangePair,
  arbDifferentRangePair,
  arbName,
  nextName,
  CONTENT_MAX,
} from "./arbitraries.js";

const SAMPLE = { seed: FC_SEED, numRuns: RUNS_PURE };

// ---------------------------------------------------------------------------
// Independent reference: text → the /64 (or /24) an address belongs to
// ---------------------------------------------------------------------------
// Written from RFC 4291's text rules, not from the generator: strip the zone id,
// fold an embedded trailing IPv4 into two hex groups, expand "::" to exactly 8
// groups, then keep the first four (v6) or the first three octets (v4).
function refRange(text: string): string {
  let s = text.trim().toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);

  if (!s.includes(":")) return "v4:" + s.split(".").slice(0, 3).join(".");

  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const o = tail.split(".").map((x) => parseInt(x, 10));
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hi + ":" + lo;
  }

  const [head, rest] = s.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = rest != null && rest !== "" ? rest.split(":") : [];
  const fill = rest != null ? new Array(8 - headParts.length - tailParts.length).fill("0") : [];
  const groups = [...headParts, ...fill, ...tailParts];
  expect(groups.length, `refRange could not expand ${JSON.stringify(text)} to 8 groups`).toBe(8);
  return "v6:" + groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16).padStart(4, "0")).join(":");
}

describe("refRange (the self-test's own yardstick)", () => {
  it("agrees on the hand-written forms design.md 6.7 enumerates", () => {
    const expected = "v6:2001:0db8:0000:0000";
    for (const form of [
      "2001:db8::1",
      "2001:db8:0:0::2",
      "2001:0db8:0000:0000:0000:0000:0000:0003",
      "2001:DB8::4",
      "2001:db8::5%eth0",
      "  2001:db8::6  ",
    ]) {
      expect(refRange(form), form).toBe(expected);
    }
    expect(refRange("2001:db9::1")).not.toBe(expected);
    expect(refRange("::ffff:192.0.2.1")).toBe("v6:0000:0000:0000:0000");
    expect(refRange("::ffff:c000:0201")).toBe("v6:0000:0000:0000:0000");
    expect(refRange("198.51.100.7")).toBe("v4:198.51.100");
    expect(refRange("198.51.101.7")).not.toBe("v4:198.51.100");
  });
});

// ---------------------------------------------------------------------------
// Seed / numRuns convention
// ---------------------------------------------------------------------------

describe("seed convention", () => {
  it("mirrors the seed and numRuns the committed preservation fixture was recorded with", () => {
    // The fixture records the values its corpus was generated with. If someone
    // changes the constants in test/preservation.test.ts (or the mirrors here),
    // the two drift and the Property 16 baseline silently stops describing the
    // corpus it claims to describe — and F is gone, so it cannot be re-recorded.
    expect((baseline as any).fastCheck).toEqual({ seed: PRESERVATION_SEED, numRuns: PRESERVATION_NUM_RUNS });
  });

  it("pins the seed into every fcParams(...) so a failure reproduces", () => {
    expect(fcParams(7)).toEqual({ seed: FC_SEED, numRuns: 7 });
    expect(fcParams(7, { endOnFailure: true })).toMatchObject({ seed: FC_SEED, numRuns: 7, endOnFailure: true });
  });
});

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

describe("arbToken", () => {
  it("only emits base64url characters, never empty", () => {
    fc.assert(
      fc.property(arbToken, (t) => {
        expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      }),
      SAMPLE,
    );
  });

  it("covers the real genToken() length (22) as well as shorter and longer shapes", () => {
    const lengths = new Set(fc.sample(arbToken, SAMPLE).map((t) => t.length));
    expect(lengths.has(22), "no 22-char token sampled — that is the shape genToken() actually emits").toBe(true);
    expect([...lengths].some((l) => l < 22)).toBe(true);
    expect([...lengths].some((l) => l > 22)).toBe(true);
  });
});

describe("arbTokenMutation", () => {
  // THE degenerate case this exists to catch: a mutant equal to the original
  // would be a token that SHOULD authenticate, so Property 3 ("no forged token
  // authenticates") would report a failure that is actually correct behavior —
  // or, worse, someone would "fix" the property to tolerate it.
  it("never produces a mutant equal to the original", () => {
    fc.assert(
      fc.property(arbTokenMutation, ({ original, mutant, kind }) => {
        expect(mutant, `kind=${kind} original=${JSON.stringify(original)}`).not.toBe(original);
      }),
      SAMPLE,
    );
  });

  it("produces every mutation kind, and each kind does what its name says", () => {
    const seen = new Map<string, number>();
    for (const m of fc.sample(arbTokenMutation, SAMPLE)) {
      seen.set(m.kind, (seen.get(m.kind) ?? 0) + 1);
      switch (m.kind) {
        case "bitflip":
          expect(m.mutant.length).toBe(m.original.length);
          expect([...m.mutant].filter((c, i) => c !== m.original[i]).length).toBe(1);
          break;
        case "truncate":
          expect(m.mutant.length).toBeLessThan(m.original.length);
          expect(m.original.startsWith(m.mutant)).toBe(true);
          break;
        case "extend":
          expect(m.mutant.length).toBeGreaterThan(m.original.length);
          expect(m.mutant.startsWith(m.original)).toBe(true);
          break;
        case "empty":
          expect(m.mutant).toBe("");
          break;
        case "wrongLength":
          expect(m.mutant.length).not.toBe(m.original.length);
          expect(m.mutant).toMatch(/^[A-Za-z0-9_-]+$/);
          break;
      }
    }
    for (const kind of TOKEN_MUTATION_KINDS) {
      expect(seen.get(kind) ?? 0, `mutation kind "${kind}" was never sampled`).toBeGreaterThan(0);
    }
  });

  it("flags exactly the empty mutants as the 400 missing_token case", () => {
    fc.assert(
      fc.property(arbTokenMutation, ({ mutant, expectMissingToken }) => {
        expect(expectMissingToken).toBe(mutant === "");
      }),
      SAMPLE,
    );
  });
});

// ---------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------

describe("arbQueryString", () => {
  it("always carries the secret value under a secret parameter name", () => {
    fc.assert(
      fc.property(arbQueryString, (c) => {
        expect(c.params.some((p) => p.secret)).toBe(true);
        for (const p of c.params.filter((x) => x.secret)) {
          expect(SECRET_PARAMS).toContain(p.name.toLowerCase());
          expect(p.value).toBe(c.secret);
        }
        expect(c.query.startsWith("?")).toBe(true);
        expect(c.query).toContain(c.secret);
        expect(c.logLine.endsWith(c.query)).toBe(true);
      }),
      SAMPLE,
    );
  });

  it("keeps every non-secret pair verbatim in the query, and never hides a secret parameter inside one", () => {
    // The second half is the constraint that keeps Property 1 honest: a
    // non-secret value containing "&edit=" or "?key=" would be redacted by
    // SECRET_QS_RE (correctly), and "non-secret parameters are byte-identical"
    // would fail for a reason design.md never claimed.
    const embedded = new RegExp(`[?&](?:${SECRET_PARAMS.join("|")})=`, "i");
    fc.assert(
      fc.property(arbQueryString, (c) => {
        for (const pair of c.nonSecretPairs) expect(c.query).toContain(pair);
        for (const p of c.params.filter((x) => !x.secret)) {
          expect(p.value).not.toContain("&");
          expect(embedded.test("?" + p.value)).toBe(false);
          expect(embedded.test("&" + p.value)).toBe(false);
        }
      }),
      SAMPLE,
    );
  });

  it("covers every position a secret can occupy, mixed-case names, and whitespace-bearing values", () => {
    const cases = fc.sample(arbQueryString, SAMPLE);
    const shapes = new Set(cases.map((c) => c.shape));
    for (const shape of ["secret-only", "secret-first", "secret-last", "secret-adjacent", "secret-repeated", "every-secret-name"]) {
      expect(shapes.has(shape as any), `shape "${shape}" was never sampled`).toBe(true);
    }
    // secret first ⇒ preceded by "?"; secret last ⇒ preceded by "&".
    expect(cases.some((c) => c.query.startsWith("?" + c.params[0].name + "=") && c.params[0].secret)).toBe(true);
    expect(cases.some((c) => c.params[c.params.length - 1].secret && c.params.length > 1)).toBe(true);
    expect(cases.some((c) => c.params.filter((p) => p.secret).length >= 2)).toBe(true);
    expect(cases.some((c) => c.params.some((p) => p.secret && p.name !== p.name.toLowerCase()))).toBe(true);
    expect(cases.some((c) => c.params.some((p) => !p.secret && /\s/.test(p.value)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** Every reason handleCreate can answer 4xx for a *content* value. */
function creationRejection(content: string): string | null {
  if (!content) return "missing_content";
  const urlMode = isUrl(content);
  const normalized = urlMode ? normalizeUrl(content) : content;
  if (urlMode && normalized.length > URL_MAX) return "url_too_long";
  if (!urlMode && normalized.length > TEXT_MAX) return "text_too_long";
  if (!urlMode) return null;
  const parsed = parseUrlSafe(normalized);
  if (!parsed) return "malformed_url";
  if (hasDangerousScheme(normalized)) return "bad_scheme";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "bad_scheme";
  if (isBlockedTargetHost(parsed.hostname)) return "shortener_blocked";
  return null;
}

describe("arbContent / arbContentCase", () => {
  it("never wanders onto an error path (413, malformed_url, shortener_blocked, missing_content)", () => {
    fc.assert(
      fc.property(arbContent, (content) => {
        expect(creationRejection(content), JSON.stringify(content.slice(0, 80))).toBe(null);
        expect(content.length).toBeLessThanOrEqual(CONTENT_MAX + 1); // +1: creatableText may append a space
      }),
      SAMPLE,
    );
  });

  it("generates both kinds — a text-only generator would make transport equivalence trivial", () => {
    const contents = fc.sample(arbContent, SAMPLE);
    expect(contents.some((c) => isUrl(c))).toBe(true);
    expect(contents.some((c) => !isUrl(c))).toBe(true);
  });

  it("covers every ttl including the omitted one, with and without renew", () => {
    const cases = fc.sample(arbContentCase, SAMPLE);
    expect(new Set(cases.map((c) => c.ttl))).toEqual(new Set(["1h", "1d", "7d", ""]));
    expect(new Set(cases.map((c) => c.renew))).toEqual(new Set([true, false]));
  });
});

describe("arbBoundaryContent", () => {
  it("is creatable in every category — a generated 400 would say nothing about kind", () => {
    fc.assert(
      fc.property(arbBoundaryContent, ({ content, category }) => {
        expect(creationRejection(content), `${category}: ${JSON.stringify(content)}`).toBe(null);
      }),
      SAMPLE,
    );
  });

  it("straddles URL_NO_SCHEME_RE — both sides of the boundary, every category sampled", () => {
    const cases = fc.sample(arbBoundaryContent, SAMPLE);
    const urlish = cases.filter((c) => isUrl(c.content));
    const texty = cases.filter((c) => !isUrl(c.content));
    // A generator that landed entirely on one side would exercise exactly one
    // branch of the read path and Property 11 would never compare anything.
    expect(urlish.length, "no url-classified content sampled").toBeGreaterThan(10);
    expect(texty.length, "no text-classified content sampled").toBeGreaterThan(10);
    const seen = new Set(cases.map((c) => c.category));
    for (const category of BOUNDARY_CATEGORIES) {
      expect(seen.has(category), `boundary category "${category}" was never sampled`).toBe(true);
    }
    // The categories whose whole point is which side they land on.
    // Whitespace: isUrl() TRIMS before testing, so a leading tab or a trailing
    // space still yields a URL — only INNER whitespace forces the text branch.
    // Both halves must be present or the category proves nothing.
    const ws = cases.filter((c) => c.category === "whitespace");
    expect(ws.every((c) => /\s/.test(c.content))).toBe(true);
    expect(ws.some((c) => !isUrl(c.content)), "whitespace category never landed on the text side").toBe(true);
    expect(ws.some((c) => isUrl(c.content)), "whitespace category never landed on the url side (isUrl trims first)").toBe(true);
    expect(cases.filter((c) => c.category === "trailing-dot").every((c) => !isUrl(c.content))).toBe(true);
    expect(cases.filter((c) => c.category === "bare-host").every((c) => isUrl(c.content))).toBe(true);
    expect(cases.filter((c) => c.category === "bare-ipv4").every((c) => isUrl(c.content))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Addresses (Property 8)
// ---------------------------------------------------------------------------

describe("arbAddressForms", () => {
  it("renders one address in forms that ALL denote the same range", () => {
    fc.assert(
      fc.property(arbAddressForms, (a) => {
        for (const form of a.forms) {
          expect(refRange(form), `${a.family} ${form} (canonical ${a.canonical})`).toBe(a.refRangeKey);
        }
      }),
      SAMPLE,
    );
  });

  it("covers compressed, expanded, uppercase, zone-id, IPv4-mapped and IPv4 text forms", () => {
    const samples = fc.sample(arbAddressForms, SAMPLE);
    const allForms = samples.flatMap((s) => s.forms);
    expect(samples.some((s) => s.family === "v6")).toBe(true);
    expect(samples.some((s) => s.family === "v6-mapped")).toBe(true);
    expect(samples.some((s) => s.family === "v4")).toBe(true);
    expect(allForms.some((f) => f.includes("::")), "no compressed form").toBe(true);
    expect(allForms.some((f) => f.split(":").length === 8), "no fully expanded form").toBe(true);
    expect(allForms.some((f) => /[A-F]/.test(f)), "no mixed/upper case hex form").toBe(true);
    expect(allForms.some((f) => f.includes("%")), "no zone-id form").toBe(true);
    expect(allForms.some((f) => /^::f{4}:\d+\.\d+\.\d+\.\d+$/i.test(f)), "no IPv4-mapped dotted form").toBe(true);
    expect(allForms.some((f) => /^\s*\d+\.\d+\.\d+\.\d+\s*$/.test(f)), "no bare IPv4 form").toBe(true);
    // Zero-bearing prefixes are what make "::" compression (and the truncation
    // bug it triggers) possible at all.
    expect(samples.some((s) => s.family === "v6" && s.groups!.slice(0, 4).includes(0))).toBe(true);
  });
});

describe("address pair generators", () => {
  it("same-range pairs really do share a /64 (or /24), in every form combination", () => {
    fc.assert(
      fc.property(arbSameRangePair, ({ a, b }) => {
        for (const fa of a.forms) {
          for (const fb of b.forms) {
            expect(refRange(fa), `${fa} vs ${fb}`).toBe(refRange(fb));
          }
        }
      }),
      SAMPLE,
    );
  });

  it("same-range pairs are two DIFFERENT addresses, not one address twice", () => {
    // The degenerate case: if a === b, "one address range counts once" would be
    // satisfied by the dedupe of an identical address and would never exercise
    // the range collapsing that Property 8 is about.
    fc.assert(
      fc.property(arbSameRangePair, ({ a, b }) => {
        expect(a.canonical).not.toBe(b.canonical);
        expect(a.family).toBe(b.family);
      }),
      SAMPLE,
    );
  });

  it("different-range pairs really are in different ranges", () => {
    fc.assert(
      fc.property(arbDifferentRangePair, ({ a, b }) => {
        for (const fa of a.forms) {
          for (const fb of b.forms) {
            expect(refRange(fa), `${fa} vs ${fb} must differ`).not.toBe(refRange(fb));
          }
        }
      }),
      SAMPLE,
    );
  });

  it("puts different-range v6 pairs on the /64 BOUNDARY, not just far apart", () => {
    const pairs = fc.sample(arbDifferentRangePair, SAMPLE).filter((p) => a4(p) != null);
    // At least some pairs differ in exactly one of the first four groups: the
    // adjacent-/64 case a truncating implementation is most likely to conflate.
    expect(pairs.some((p) => a4(p) === 1), "no adjacent-/64 pair sampled").toBe(true);
  });
});

/** For a v6/v6 pair: how many of the first four groups differ (null otherwise). */
function a4(p: { a: any; b: any }): number | null {
  if (!p.a.groups || !p.b.groups) return null;
  let n = 0;
  for (let i = 0; i < 4; i++) if (p.a.groups[i] !== p.b.groups[i]) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe("note name generation", () => {
  it("nextName is unique, valid, non-reserved and non-brand across a long run", () => {
    const names = Array.from({ length: 800 }, () => nextName());
    expect(new Set(names).size, "duplicate name minted — a generated 409 name_taken would fail a property spuriously").toBe(800);
    for (const n of names) {
      expect(NAME_RE.test(n), n).toBe(true);
      expect(RESERVED.has(n)).toBe(false);
      expect(isBrandSquatting(n)).toBe(null);
    }
  });

  it("arbName is likewise unique and valid, and exercises hyphenated shapes", () => {
    const names = fc.sample(arbName, SAMPLE);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(NAME_RE.test(n), n).toBe(true);
      expect(RESERVED.has(n)).toBe(false);
      expect(isBrandSquatting(n)).toBe(null);
    }
    expect(names.some((n) => n.includes("-")), "no hyphenated name sampled").toBe(true);
  });
});
