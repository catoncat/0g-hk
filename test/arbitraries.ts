// Shared fast-check arbitraries for the write-path-security-hardening spec.
//
// One module owns every generated input domain so each fix task consumes a
// reviewed generator instead of redefining the domain inline (and getting the
// bounds subtly wrong). Every export below names the property it serves; the
// mapping mirrors design.md's *Property → test mapping* table.
//
//   arbToken / arbTokenMutation   Property 3  (no forged token authenticates)
//   arbQueryString                Property 1  (redactLogLine)
//   arbContent / arbTtl           Property 2  (transport equivalence)
//   arbAddressForms + pairs       Property 8  (reporterGroup)
//   arbBoundaryContent            Properties 11, 12, 14 (persisted kind)
//   arbName / nextName            every property that has to create a note
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY *NOT* GENERATED — DO NOT "HELPFULLY" CONVERT IT LATER
// ---------------------------------------------------------------------------
// design.md keeps Properties 4, 5, 7, 9, 10, 13 and 15 EXAMPLE-BASED on
// purpose. They all assert on ordered multi-request sequences against shared KV
// counters (`rej:<day>:<code>`, `rej-ip:<ip>`, `abuse:<name>`, `d:<name>`), and:
//
//   1. `recordReject`'s read-modify-write is NON-ATOMIC. A generator that
//      varies sequence length/order would have to serialize every request
//      anyway, so it buys no coverage — and any concurrency it introduced would
//      lose an increment and fail for a reason unrelated to the property.
//   2. The interesting inputs are the thresholds themselves (1/3/5 rejections,
//      n ∈ {1,5,9} reports, exactly ADAPTIVE_REJECT_THRESHOLD, exactly
//      ABUSE_AUTO_QUARANTINE). Those are a handful of named points, not a
//      domain; enumerating them is both faster and more legible than sampling.
//   3. Each case costs 5–15 real KV round trips. Generation there would make
//      the suite unusable for the same assertions.
//
// So: no arbitraries in this file feed those properties, and none should be
// added for them. Property 16's corpus generator lives inline in
// test/preservation.test.ts and stays there (see PRESERVATION_* below).
import fc from "fast-check";
import { NAME_RE, RESERVED, TEXT_MAX, URL_MAX, TTL_OPTIONS } from "../src/constants.js";
import { isBrandSquatting, isBlockedTargetHost, isUrl, normalizeUrl, parseUrlSafe } from "../src/util.js";

// ---------------------------------------------------------------------------
// Seed / numRuns convention
// ---------------------------------------------------------------------------
//
// SEED: one value for the whole suite, pinned. fast-check otherwise picks a
// fresh seed per run, so a property that fails on 1 input in 50 would be a
// flake nobody can reproduce. Pinned, a failure reproduces exactly and the
// printed counterexample stays meaningful across CI runs. Raising numRuns (or
// changing the seed) explores new inputs and is a deliberate, reviewable act.
//
// numRuns: measured, not guessed. The suite as it stands (42 tests, most of
// test/preservation.test.ts's ~300 Worker requests included) runs in ~4.3s in
// this sandbox — roughly 10ms per SELF.fetch round trip against miniflare's KV.
// So the budget is set per class of property:
//
//   RUNS_PURE   (300) — pure functions, zero I/O (redactLogLine, reporterGroup).
//                       300 runs cost single-digit milliseconds; there is no
//                       reason to be stingy where the domain is large and the
//                       cost is nil.
//   RUNS_WORKER  (15) — 1–6 Worker round trips per case (Property 11's create +
//                       read, Property 12's create + 5 reads, Property 14's
//                       create + edit + read). ≈90 requests ≈ 1s.
//   RUNS_HEAVY    (6) — ≥8 round trips per case. Property 2 creates THREE
//                       notes, edits each via a different transport, and
//                       re-reads three /raw bodies: ~12 requests per case.
//                       6 runs ≈ 72 requests ≈ 0.8s, and the transport domain
//                       is small (3 transports × 4 ttl values × renew) so extra
//                       runs mostly re-sample the same shapes.
//   RUNS_FORGED  (25) — Property 3: 3 transports + 1 /raw check per case, but
//                       the mutation domain (5 kinds × token shapes) is the
//                       whole point, so it gets more runs than RUNS_WORKER.
export const FC_SEED = 20260817;
export const RUNS_PURE = 300;
export const RUNS_WORKER = 15;
export const RUNS_HEAVY = 6;
export const RUNS_FORGED = 25;

/** fast-check Parameters with the pinned seed. `fc.assert(prop, fcParams(RUNS_PURE))`. */
export function fcParams(numRuns: number, extra: Record<string, unknown> = {}): any {
  return { seed: FC_SEED, numRuns, ...extra };
}

// Property 16's corpus is generated INLINE in test/preservation.test.ts with
// these exact values, and stays there on purpose: the recorded fixture in
// test/__fixtures__/preservation-baseline.json was produced by that generator
// against the UNFIXED tree, and F no longer exists to re-record it. If the
// generator lived here, an innocent edit to this shared module would silently
// change the corpus and invalidate the committed baseline. Mirrored (not
// imported) so the values are documented in one obvious place; a drift between
// the two is caught by test/arbitraries.test.ts.
export const PRESERVATION_SEED = 20260817;
export const PRESERVATION_NUM_RUNS = 10;

// ---------------------------------------------------------------------------
// Note names (needed by nearly every property that touches the Worker)
// ---------------------------------------------------------------------------
//
// A generated duplicate name fails with `409 name_taken` — a real failure, for
// a reason that has nothing to do with the property under test. Names are
// therefore minted from a MONOTONIC counter rather than sampled, and screened
// against the three rejections create() can raise on a name: NAME_RE,
// RESERVED, and isBrandSquatting.
let nameCounter = 0;

/**
 * A note name that is valid, non-reserved, non-brand, and unique within the run.
 * `prefix` only affects legibility of failures; uniqueness comes from the counter.
 */
export function nextName(prefix = "pg"): string {
  for (;;) {
    const candidate = `${prefix}${nameCounter++}`;
    if (!NAME_RE.test(candidate)) continue;
    if (RESERVED.has(candidate)) continue;
    if (isBrandSquatting(candidate)) continue;
    return candidate;
  }
}

/** Reset the name counter (per-test, when a failure message should be stable). */
export function resetNameCounter(): void {
  nameCounter = 0;
}

// Stems exercise the shape NAME_RE actually allows: lowercase alnum, optional
// internal hyphens, never leading/trailing (the trailing counter guarantees the
// last character is a digit).
const NAME_CHARS = "abcdefghijkmnpqrstuvwxyz23456789".split("");
const arbNameStem = fc
  .array(
    fc.array(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 5 }).map((cs) => cs.join("")),
    { minLength: 1, maxLength: 3 },
  )
  .map((parts) => parts.join("-"));

/**
 * A generated-but-unique note name.
 *
 * NOTE: deliberately impure — the monotonic suffix means shrinking re-mints a
 * name rather than replaying one. Uniqueness is worth more here than shrink
 * reproducibility, because the name is never the cause of a property failure.
 */
export const arbName: fc.Arbitrary<string> = arbNameStem.map((stem) => nextName(stem));

// ---------------------------------------------------------------------------
// Property 3 — edit tokens and their mutations
// ---------------------------------------------------------------------------

/** base64url alphabet, exactly what genToken() emits after the +/ → -_ swap. */
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");

export function arbBase64Url(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...B64URL), { minLength, maxLength }).map((cs) => cs.join(""));
}

/**
 * Edit-token shapes.
 *
 * genToken() is 16 random bytes → 22 base64url characters (the "=="" padding is
 * stripped), so 22 is the shape that actually reaches `meta.h`. The other
 * lengths cover tokens a client might present: a truncated copy/paste, a longer
 * token from a future generator, a single character.
 */
export const arbToken: fc.Arbitrary<string> = fc.oneof(
  arbBase64Url(22, 22), // the real genToken() shape
  arbBase64Url(1, 21), // short / truncated
  arbBase64Url(23, 64), // longer than today's generator emits
);

export type TokenMutationKind = "bitflip" | "truncate" | "extend" | "empty" | "wrongLength";
export const TOKEN_MUTATION_KINDS: TokenMutationKind[] = ["bitflip", "truncate", "extend", "empty", "wrongLength"];

export interface TokenMutation {
  /** The token the note was actually created with. */
  original: string;
  /** The forged token to present. GUARANTEED !== original. */
  mutant: string;
  kind: TokenMutationKind;
  /**
   * Property 3's expected error code depends only on emptiness:
   * "" ⇒ 400 missing_token, anything else ⇒ 403 invalid_token.
   */
  expectMissingToken: boolean;
}

function flipChar(s: string, at: number, step: number): string {
  const i = at % s.length;
  const cur = B64URL.indexOf(s[i]);
  const base = cur < 0 ? 0 : cur;
  // step ∈ 1..63 and the alphabet is 64 long, so the replacement can never
  // land back on the original character.
  const next = B64URL[(base + 1 + (step % (B64URL.length - 1))) % B64URL.length];
  return s.slice(0, i) + next + s.slice(i + 1);
}

function mutateToken(original: string, kind: TokenMutationKind, at: number, step: number, extra: string): string {
  switch (kind) {
    case "bitflip":
      return flipChar(original, at, step);
    case "truncate":
      // 1..len-1 characters kept; a 1-char original degrades to "", which is
      // still a mutation (and still a valid Property 3 input).
      return original.length <= 1 ? "" : original.slice(0, original.length - (1 + (at % (original.length - 1))));
    case "extend":
      return original + extra; // extra has minLength 1
    case "empty":
      return "";
    case "wrongLength": {
      // A well-formed base64url string of a DIFFERENT length: the shape a
      // client sends when it pads, re-encodes, or concatenates a token.
      const target = original.length + 1 + (step % 8);
      return (original + extra).repeat(Math.ceil(target / Math.max(1, original.length + extra.length)) + 1).slice(0, target);
    }
  }
}

/**
 * A (real token, forged token) pair for Property 3.
 *
 * INVARIANT: mutant !== original, enforced here rather than filtered. A
 * generator that occasionally emitted the real token would make "no forged
 * token authenticates" fail for the one input where authentication is correct —
 * so the degenerate case throws loudly instead of being silently dropped.
 * test/arbitraries.test.ts checks the invariant over many samples.
 */
export const arbTokenMutation: fc.Arbitrary<TokenMutation> = fc
  .record({
    original: arbToken,
    kind: fc.constantFrom(...TOKEN_MUTATION_KINDS) as fc.Arbitrary<TokenMutationKind>,
    at: fc.nat({ max: 1_000_000 }),
    step: fc.nat({ max: 1_000_000 }),
    extra: arbBase64Url(1, 6),
  })
  .map(({ original, kind, at, step, extra }) => {
    const mutant = mutateToken(original, kind, at, step, extra);
    if (mutant === original) {
      throw new Error(`arbTokenMutation produced a non-mutation (kind=${kind}, token=${JSON.stringify(original)})`);
    }
    return { original, mutant, kind, expectMissingToken: mutant === "" };
  });

// ---------------------------------------------------------------------------
// Property 1 — query strings mixing secret and non-secret parameters
// ---------------------------------------------------------------------------

/** Parameter names redactLogLine must strip the value of (design.md 6.2). */
export const SECRET_PARAMS = ["edit", "token", "key", "ts"] as const;
/** Parameter names that must survive BYTE-IDENTICALLY. */
export const NON_SECRET_PARAMS = ["c", "n", "ttl", "format"] as const;

export type QueryShape =
  | "secret-only"
  | "secret-first"
  | "secret-last"
  | "secret-adjacent"
  | "secret-repeated"
  | "every-secret-name";

export interface QueryParam {
  name: string;
  value: string;
  secret: boolean;
}

export interface QueryStringCase {
  /** Query string INCLUDING the leading "?" — SECRET_QS_RE anchors on [?&]. */
  query: string;
  /** A hono-logger-shaped incoming line: `<-- GET /path?query`. */
  logLine: string;
  /** The value carried by every secret parameter in this case. */
  secret: string;
  params: QueryParam[];
  /** `name=value` of each non-secret parameter; each must be unchanged after redaction. */
  nonSecretPairs: string[];
  shape: QueryShape;
}

// Non-secret values that stress the `[^&\s]*` boundary of SECRET_QS_RE:
// percent-encoding, colons, slashes, an equals sign inside a value, unicode,
// and one RAW SPACE (the `\s` half of the character class).
//
// CONSTRAINT, deliberate: no generated non-secret value contains "&" or a "?"
// followed by a secret parameter name. Such a value would EMBED a secret
// parameter inside a non-secret one, the regex would (correctly) redact it, and
// "non-secret parameters are byte-identical" would fail for a reason design.md
// never claimed. test/arbitraries.test.ts asserts the constraint holds.
const URLISH_VALUES = [
  "x",
  "hello",
  "1h",
  "json",
  "example.com",
  "https://example.com/a/b",
  "https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc",
  "a-b_c.d~e",
  "%E4%B8%AD%E6%96%87",
  "1.2.3.4:8080/p=q",
  "eq=inside=value",
  "raw space value",
  "trailing-",
  "..",
];
const arbNonSecretValue = fc.constantFrom(...URLISH_VALUES);
const arbNonSecretName = fc.constantFrom(...NON_SECRET_PARAMS);
const arbNonSecretParam: fc.Arbitrary<QueryParam> = fc
  .record({ name: arbNonSecretName, value: arbNonSecretValue })
  .map(({ name, value }) => ({ name, value, secret: false }));

// Secret parameter names are generated in mixed case: SECRET_QS_RE carries the
// `i` flag, and the replacement keeps `$1`, so the ORIGINAL casing of the name
// must survive. A lowercase-only generator would never notice a regex that
// dropped the flag or rewrote the name.
const arbSecretName = fc
  .record({ name: fc.constantFrom(...SECRET_PARAMS), upper: fc.boolean(), firstUpper: fc.boolean() })
  .map(({ name, upper, firstUpper }) =>
    upper ? name.toUpperCase() : firstUpper ? name[0].toUpperCase() + name.slice(1) : name,
  );

function renderQuery(params: QueryParam[]): string {
  return "?" + params.map((p) => `${p.name}=${p.value}`).join("&");
}

/**
 * Query strings for Property 1.
 *
 * Shapes cover every position a secret can occupy — first, last, sandwiched
 * between non-secrets, repeated, alone — plus one case carrying all four secret
 * names at once. Position matters because SECRET_QS_RE's `[?&]` prefix behaves
 * differently at the head of the query (`?`) than inside it (`&`), and because
 * a non-global or non-repeating regex would redact only the first occurrence.
 */
export const arbQueryString: fc.Arbitrary<QueryStringCase> = fc
  .record({
    secret: arbToken,
    shape: fc.constantFrom(
      ...([
        "secret-only",
        "secret-first",
        "secret-last",
        "secret-adjacent",
        "secret-repeated",
        "every-secret-name",
      ] as QueryShape[]),
    ),
    secretName: arbSecretName,
    secretName2: arbSecretName,
    before: fc.array(arbNonSecretParam, { minLength: 1, maxLength: 3 }),
    after: fc.array(arbNonSecretParam, { minLength: 1, maxLength: 3 }),
    path: fc.constantFrom("/", "/edit", "/raw", "/admin/stats", "/abuse/report"),
    method: fc.constantFrom("GET", "POST", "PUT"),
  })
  .map(({ secret, shape, secretName, secretName2, before, after, path, method }) => {
    const s = (name: string): QueryParam => ({ name, value: secret, secret: true });
    let params: QueryParam[];
    switch (shape) {
      case "secret-only":
        params = [s(secretName)];
        break;
      case "secret-first":
        params = [s(secretName), ...after];
        break;
      case "secret-last":
        params = [...before, s(secretName)];
        break;
      case "secret-adjacent":
        params = [...before, s(secretName), ...after];
        break;
      case "secret-repeated":
        params = [s(secretName), ...before, s(secretName), ...after, s(secretName2)];
        break;
      case "every-secret-name":
        params = [...SECRET_PARAMS.map((n) => s(n)), ...after];
        break;
    }
    const query = renderQuery(params);
    return {
      query,
      logLine: `<-- ${method} ${path}${query}`,
      secret,
      params,
      nonSecretPairs: params.filter((p) => !p.secret).map((p) => `${p.name}=${p.value}`),
      shape,
    };
  });

// ---------------------------------------------------------------------------
// Property 2 — content and ttl
// ---------------------------------------------------------------------------
//
// Ceilings are the REAL ones: cfg.urlMax / cfg.textMax, which default to
// URL_MAX (2 KiB) and TEXT_MAX (24 KiB) and are not overridden in the test env.
// Generation stays an order of magnitude below them, for two reasons:
//   - the 413 path must never be reached by accident (a generated 413 would
//     fail transport equivalence for a reason unrelated to the transport), and
//   - every generated case is a real KV write; 24 KiB payloads would make the
//     property slow while proving nothing extra.
//   - the cap is below URL_MAX as well as TEXT_MAX, so a text string that
//     happens to satisfy isUrl() (no whitespace + dotted host) is still safely
//     under the *url* ceiling it will then be measured against.
export const CONTENT_MAX = Math.min(URL_MAX, TEXT_MAX) / 2; // 1024

// Hosts are drawn from a safe pool: SHORTENER_HOSTS members (bit.ly, 0g.hk, …)
// would trip `shortener_blocked`, and every label is ≥3 characters so a
// single-letter shortener host (t.co, x.gd, v.gd) cannot be assembled by chance.
const SAFE_LABELS = ["example", "docs", "site", "host", "alpha", "beta", "notes", "inner", "edge9", "a-b"];
const SAFE_TLDS = ["com", "net", "org", "io", "dev", "example", "test"];
// Ports are bounded to 1..65535. URL_NO_SCHEME_RE accepts `:\d{1,5}`, so
// :99999 satisfies isUrl() but then throws in `new URL()` and yields
// `400 malformed_url` — an error path this generator must stay off.
const arbPort = fc.oneof(fc.constantFrom(80, 443, 8080, 3000), fc.integer({ min: 1, max: 65535 }));
const arbLabel = fc.constantFrom(...SAFE_LABELS);
const arbTld = fc.constantFrom(...SAFE_TLDS);
const arbPath = fc
  .array(fc.constantFrom("a", "b", "path", "x-1", "%20", "d.e"), { minLength: 1, maxLength: 3 })
  .map((ps) => ps.join("/"));

const arbHost: fc.Arbitrary<string> = fc
  .record({ sub: fc.option(arbLabel, { nil: undefined }), label: arbLabel, tld: arbTld })
  .map(({ sub, label, tld }) => (sub ? `${sub}.${label}.${tld}` : `${label}.${tld}`));

/** URL-shaped content, always creatable: http(s) or scheme-less, safe host, valid port. */
export const arbUrlContent: fc.Arbitrary<string> = fc
  .record({
    scheme: fc.constantFrom("https://", "http://", ""),
    host: arbHost,
    port: fc.option(arbPort, { nil: undefined }),
    path: fc.option(arbPath, { nil: undefined }),
    query: fc.option(fc.constantFrom("a=b", "q=1&r=2", "x=%20"), { nil: undefined }),
  })
  .map(({ scheme, host, port, path, query }) => {
    let s = scheme + host + (port ? `:${port}` : "");
    if (path) s += "/" + path;
    if (query) s += "?" + query;
    return s.slice(0, CONTENT_MAX);
  });

// Text characters: ASCII printable plus CJK, an emoji, a combining-ish accent
// and newlines/tabs. Control characters below 0x09 are excluded — they survive
// KV but make failure output unreadable, and nothing in the write path branches
// on them.
const TEXT_CHARS = [
  ...".,-_/:!?#*`'\"()[]{}=+~$%@^|<>;\\ \n\t".split(""),
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
  "中",
  "文",
  "笔",
  "记",
  "😀",
  "→",
  "é",
  "ß",
];

/**
 * Last-mile guard for the OPEN text domain.
 *
 * A random character string can, with tiny but non-zero probability, land
 * exactly on a shortener host ("t.ly", "0g.hk") or on an isUrl()-true string
 * that `new URL()` rejects (":99999" is 5 digits, so URL_NO_SCHEME_RE accepts
 * it). Either would answer 400 and fail a property for a reason unrelated to
 * the property. Appending one space pushes such a string back onto the text
 * branch; for every other input this is the identity function.
 */
function creatableText(s: string): string {
  if (!isUrl(s)) return s;
  const u = parseUrlSafe(normalizeUrl(s));
  if (!u || isBlockedTargetHost(u.hostname)) return s + " ";
  return s;
}

/** Text-shaped content, always creatable: non-empty and under both ceilings. */
export const arbTextContent: fc.Arbitrary<string> = fc.oneof(
  fc.array(fc.constantFrom(...TEXT_CHARS), { minLength: 1, maxLength: 200 }).map((cs) => cs.join("")),
  // A few larger bodies, still far below TEXT_MAX, so the property sees more
  // than tweet-sized notes.
  fc
    .record({ unit: fc.constantFrom("lorem ipsum ", "# heading\n\n", "中文笔记 ", "**bold** "), reps: fc.integer({ min: 8, max: 40 }) })
    .map(({ unit, reps }) => unit.repeat(reps).slice(0, CONTENT_MAX)),
  fc.constantFrom(
    "hello world",
    "plain",
    "# md heading\n\nbody text",
    "line1\nline2\nline3",
    "note: see example.com for details",
    "  leading and trailing whitespace  ",
  ),
).map(creatableText);

/** Either shape. Both are guaranteed creatable — see the ceiling note above. */
export const arbContent: fc.Arbitrary<string> = fc.oneof(arbTextContent, arbUrlContent);

export type TtlKey = keyof typeof TTL_OPTIONS;
/** `""` means "omit the parameter" — design.md's `ttl ∈ {1h, 1d, 7d, ∅}`. */
export const arbTtl: fc.Arbitrary<TtlKey | ""> = fc.constantFrom(...(["1h", "1d", "7d", ""] as Array<TtlKey | "">));

export interface ContentCase {
  content: string;
  /** "" ⇒ send no ttl at all. */
  ttl: TtlKey | "";
  /** false ⇒ send no renew at all. */
  renew: boolean;
}

/** Property 2's input: `(content, ttl ∈ {1h,1d,7d,∅}, renew?)`. */
export const arbContentCase: fc.Arbitrary<ContentCase> = fc.record({
  content: arbContent,
  ttl: arbTtl,
  renew: fc.boolean(),
});

// ---------------------------------------------------------------------------
// Properties 11, 12, 14 — content straddling URL_NO_SCHEME_RE
// ---------------------------------------------------------------------------
//
// URL_NO_SCHEME_RE (src/util.ts, module-private) is:
//   /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?(\/[^\s]*)?$/i
// and isUrl() additionally short-circuits on /^https?:\/\//i and rejects
// anything containing whitespace. The categories below sit on both sides of
// that boundary and on the edges themselves, which is where a read-time
// re-derivation and a write-time persisted `k` are most likely to disagree.
//
// CONTRACT: every value is CREATABLE — non-empty, under both ceilings, no
// dangerous scheme, no shortener host, port in range. A generated error
// response would fail Properties 11/12/14 without saying anything about kind.
// test/arbitraries.test.ts enforces the contract mechanically.
export type BoundaryCategory =
  | "bare-host"
  | "host-port"
  | "host-port-path"
  | "host-path"
  | "with-scheme"
  | "whitespace"
  | "punycode-ish"
  | "trailing-dot"
  | "bare-ipv4"
  | "single-label"
  | "hyphen-edge"
  | "upper-host"
  | "prose";

export interface BoundaryContent {
  content: string;
  category: BoundaryCategory;
}

const arbWord = fc.constantFrom("hello", "world", "note", "see", "笔记", "read-me");

const boundaryByCategory: Array<[BoundaryCategory, fc.Arbitrary<string>]> = [
  ["bare-host", arbHost],
  ["host-port", fc.record({ h: arbHost, p: arbPort }).map(({ h, p }) => `${h}:${p}`)],
  [
    "host-port-path",
    fc.record({ h: arbHost, p: arbPort, path: arbPath }).map(({ h, p, path }) => `${h}:${p}/${path}?a=b`),
  ],
  ["host-path", fc.record({ h: arbHost, path: arbPath }).map(({ h, path }) => `${h}/${path}`)],
  [
    "with-scheme",
    fc
      .record({ scheme: fc.constantFrom("https://", "http://", "HTTPS://", "Http://"), h: arbHost, path: arbPath })
      .map(({ scheme, h, path }) => `${scheme}${h}/${path}#frag`),
  ],
  [
    // Whitespace is the isUrl() short-circuit: these must all stay text.
    "whitespace",
    fc.oneof(
      fc.record({ h: arbHost, w: arbWord }).map(({ h, w }) => `${h} ${w}`),
      fc.record({ h: arbHost, path: arbPath }).map(({ h, path }) => `${h}/${path} `),
      fc.record({ a: arbWord, b: arbWord }).map(({ a, b }) => `${a} ${b}`),
      fc.record({ h: arbHost }).map(({ h }) => `\t${h}`),
    ),
  ],
  [
    "punycode-ish",
    fc.record({ l: fc.constantFrom("fsq", "kcrx6c", "80akhbyknj4f"), tld: arbTld }).map(({ l, tld }) => `xn--${l}.${tld}`),
  ],
  ["trailing-dot", arbHost.map((h) => `${h}.`)],
  [
    "bare-ipv4",
    fc
      .record({ o: fc.array(fc.integer({ min: 1, max: 254 }), { minLength: 4, maxLength: 4 }), path: fc.option(arbPath, { nil: undefined }) })
      .map(({ o, path }) => o.join(".") + (path ? "/" + path : "")),
  ],
  ["single-label", fc.constantFrom("plain", "localhost", "notes", "a", "9")],
  [
    // Leading/trailing hyphens fail URL_NO_SCHEME_RE; a doubled internal hyphen
    // passes it. Both sides of the same character.
    "hyphen-edge",
    fc.record({ h: arbHost }).map(({ h }) => h).chain((h) => fc.constantFrom(`-${h}`, `${h}-`, `a--b.${h}`, `${h}-.com`)),
  ],
  ["upper-host", arbHost.map((h) => h.toUpperCase() + "/Path")],
  [
    "prose",
    fc
      .record({ w: arbWord, h: arbHost })
      .map(({ w, h }) => `# ${w}\n\nsee ${h} — **bold** and \`code\``),
  ],
];

export const BOUNDARY_CATEGORIES: BoundaryCategory[] = boundaryByCategory.map(([c]) => c);

/** One content string per generated case, tagged with the category it came from. */
export const arbBoundaryContent: fc.Arbitrary<BoundaryContent> = fc.oneof(
  ...boundaryByCategory.map(([category, arb]) => arb.map((content) => ({ content, category }))),
);

/**
 * Property 14's input: a content rewrite that may or may not flip the kind.
 * Both halves are drawn from the boundary domain, so the pair covers
 * text→url, url→text, url→url and text→text transitions.
 */
export const arbBoundaryRewrite: fc.Arbitrary<{ from: BoundaryContent; to: BoundaryContent }> = fc.record({
  from: arbBoundaryContent,
  to: arbBoundaryContent,
});

// ---------------------------------------------------------------------------
// Property 8 — one address, many text forms; and same/different-range pairs
// ---------------------------------------------------------------------------
//
// reporterGroup (design.md 6.7) must collapse an address to its /64 (IPv6) or
// /24 (IPv4) REGARDLESS of the text form it arrived in. The generator therefore
// works MODEL → TEXT: it picks numeric groups/octets and renders them several
// ways. test/arbitraries.test.ts checks the forms with an independent
// TEXT → MODEL reference parser, so a bug in one direction cannot hide a bug in
// the other. Neither ever calls reporterGroup, which does not exist yet.

export type AddressFamily = "v6" | "v6-mapped" | "v4";

export interface AddressForms {
  family: AddressFamily;
  /** Canonical rendering (compressed for v6, dotted quad for v4). */
  canonical: string;
  /** Text renderings that all denote the SAME address. */
  forms: string[];
  /** All 8 v6 groups, or undefined for v4. */
  groups?: number[];
  /** All 4 v4 octets, or undefined for v6. */
  octets?: number[];
  /**
   * REFERENCE rendering of the range reporterGroup must collapse to
   * ("v6:xxxx:xxxx:xxxx:xxxx" / "v4:a.b.c"). This is the self-test's yardstick,
   * NOT a promise about reporterGroup's output format — tests should compare
   * two addresses' groups for equality rather than against this literal.
   */
  refRangeKey: string;
}

const hex4 = (n: number) => n.toString(16).padStart(4, "0");

function compressV6(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (groups[i] === 0) {
      let j = i;
      while (j < 8 && groups[j] === 0) j++;
      if (j - i > bestLen) {
        bestLen = j - i;
        bestStart = i;
      }
      i = j;
    } else i++;
  }
  const parts = groups.map((g) => g.toString(16));
  // Only runs of ≥2 are compressed: "::" for a single zero group is accepted by
  // some parsers but is not a form a client actually sends.
  if (bestLen < 2) return parts.join(":");
  return parts.slice(0, bestStart).join(":") + "::" + parts.slice(bestStart + bestLen).join(":");
}

const expandedV6 = (groups: number[]) => groups.map(hex4).join(":");
const unpaddedV6 = (groups: number[]) => groups.map((g) => g.toString(16)).join(":");
const v6RangeKey = (groups: number[]) => "v6:" + groups.slice(0, 4).map(hex4).join(":");

function v6Forms(groups: number[]): AddressForms {
  const canonical = compressV6(groups);
  return {
    family: "v6",
    canonical,
    forms: [
      canonical,
      expandedV6(groups),
      unpaddedV6(groups),
      expandedV6(groups).toUpperCase(),
      canonical + "%eth0",
      expandedV6(groups).toUpperCase() + "%42",
      "  " + canonical + "  ", // reporterGroup trims
    ],
    groups: groups.slice(),
    refRangeKey: v6RangeKey(groups),
  };
}

function mappedForms(octets: number[]): AddressForms {
  const g6 = (octets[0] << 8) | octets[1];
  const g7 = (octets[2] << 8) | octets[3];
  const groups = [0, 0, 0, 0, 0, 0xffff, g6, g7];
  const dotted = `::ffff:${octets.join(".")}`;
  return {
    family: "v6-mapped",
    canonical: dotted,
    forms: [
      dotted,
      `::FFFF:${octets.join(".")}`, // uppercase hex, dotted tail
      `::ffff:${g6.toString(16)}:${g7.toString(16)}`,
      `::FFFF:${hex4(g6)}:${hex4(g7)}`,
      expandedV6(groups),
      dotted + "%eth0",
    ],
    groups,
    // Every IPv4-mapped address lives in ::/64, so all of them share ONE range.
    refRangeKey: v6RangeKey(groups),
  };
}

function v4Forms(octets: number[]): AddressForms {
  const canonical = octets.join(".");
  return {
    family: "v4",
    canonical,
    // NOTE: no leading-zero forms ("192.000.002.001"). design.md 6.7 specifies
    // lowercase + trim + first-three-octet truncation for IPv4 and does NOT
    // promise leading-zero normalization, so generating those forms would
    // assert behavior the design never claimed.
    forms: [canonical, ` ${canonical} `, `${canonical}\t`],
    octets: octets.slice(),
    refRangeKey: "v4:" + octets.slice(0, 3).join("."),
  };
}

// Groups skew towards real-world prefixes and zeros, because zeros are what
// make "::" compression (and the truncation bug it triggers) possible at all.
const arbGroup = fc.oneof(
  fc.constant(0),
  fc.constantFrom(0x2001, 0x0db8, 0xfe80, 0x0001, 0xffff, 0x00ff, 0x1234),
  fc.integer({ min: 0, max: 0xffff }),
);
const arbGroup4 = fc.array(arbGroup, { minLength: 4, maxLength: 4 });
const arbOctet = fc.integer({ min: 0, max: 255 });
const arbOctet4 = fc.array(arbOctet, { minLength: 4, maxLength: 4 });

/** One address, rendered in many equivalent text forms. */
export const arbAddressForms: fc.Arbitrary<AddressForms> = fc.oneof(
  fc.tuple(arbGroup4, arbGroup4).map(([p, s]) => v6Forms([...p, ...s])),
  arbOctet4.map((o) => mappedForms(o)),
  arbOctet4.map((o) => v4Forms(o)),
);

export interface AddressPair {
  a: AddressForms;
  b: AddressForms;
  /** True ⇒ a and b are DIFFERENT addresses inside ONE /64 (or /24). */
  sameRange: boolean;
}

/**
 * Two DISTINCT addresses guaranteed to share a /64 (IPv6) or /24 (IPv4).
 *
 * "Distinct" matters: a pair that was secretly the same address twice would
 * make "one range counts once" pass without exercising the collapsing at all.
 */
export const arbSameRangePair: fc.Arbitrary<AddressPair> = fc.oneof(
  // v6: identical first 4 groups, suffix forced to differ.
  fc
    .record({ prefix: arbGroup4, suffixA: arbGroup4, suffixB: arbGroup4, at: fc.nat({ max: 3 }), xor: fc.integer({ min: 1, max: 0xffff }) })
    .map(({ prefix, suffixA, suffixB, at, xor }) => {
      const forced = suffixB.slice();
      forced[at] = suffixA[at] ^ xor; // guaranteed !== suffixA[at]
      return { a: v6Forms([...prefix, ...suffixA]), b: v6Forms([...prefix, ...forced]), sameRange: true };
    }),
  // v4: identical first 3 octets, last octet forced to differ.
  fc
    .record({ octets: arbOctet4, delta: fc.integer({ min: 1, max: 255 }) })
    .map(({ octets, delta }) => {
      const b = octets.slice();
      b[3] = (octets[3] + delta) % 256; // delta ∈ 1..255 ⇒ different octet
      return { a: v4Forms(octets), b: v4Forms(b), sameRange: true };
    }),
  // IPv4-mapped: every mapped address is inside ::/64, so two different mapped
  // addresses are always the same range. This is the case the naive
  // split(":").slice(0,4) truncation gets accidentally right and the
  // dotted↔hex equivalence gets wrong.
  fc
    .record({ octets: arbOctet4, delta: fc.integer({ min: 1, max: 255 }) })
    .map(({ octets, delta }) => {
      const b = octets.slice();
      b[3] = (octets[3] + delta) % 256;
      return { a: mappedForms(octets), b: mappedForms(b), sameRange: true };
    }),
);

/**
 * Two addresses guaranteed to be in DIFFERENT ranges.
 *
 * The v6 case derives B's prefix from A's by flipping bits in ONE of the first
 * four groups, so the pair usually straddles adjacent /64s — the boundary,
 * which is the interesting place, rather than two random unrelated addresses.
 *
 * NOTE: there is no mapped-vs-mapped case, because there cannot be one — all
 * IPv4-mapped addresses share ::/64. A mapped address is instead paired with a
 * v6 address whose prefix is forced non-zero.
 */
export const arbDifferentRangePair: fc.Arbitrary<AddressPair> = fc.oneof(
  // v6 vs v6: one prefix group flipped.
  fc
    .record({ prefix: arbGroup4, suffixA: arbGroup4, suffixB: arbGroup4, at: fc.nat({ max: 3 }), xor: fc.integer({ min: 1, max: 0xffff }) })
    .map(({ prefix, suffixA, suffixB, at, xor }) => {
      const other = prefix.slice();
      other[at] = prefix[at] ^ xor;
      return { a: v6Forms([...prefix, ...suffixA]), b: v6Forms([...other, ...suffixB]), sameRange: false };
    }),
  // v4 vs v4: one of the first three octets shifted.
  fc
    .record({ octets: arbOctet4, at: fc.nat({ max: 2 }), delta: fc.integer({ min: 1, max: 255 }) })
    .map(({ octets, at, delta }) => {
      const b = octets.slice();
      b[at] = (octets[at] + delta) % 256;
      return { a: v4Forms(octets), b: v4Forms(b), sameRange: false };
    }),
  // v4 vs v6: different families can never share a range.
  fc
    .record({ octets: arbOctet4, prefix: arbGroup4, suffix: arbGroup4, force: fc.integer({ min: 1, max: 0xffff }) })
    .map(({ octets, prefix, suffix, force }) => {
      const p = prefix.slice();
      p[0] = p[0] === 0 ? force : p[0];
      return { a: v4Forms(octets), b: v6Forms([...p, ...suffix]), sameRange: false };
    }),
  // IPv4-mapped vs a genuine v6 address with a NON-ZERO first group, so the
  // ::/64 that holds every mapped address is definitely not B's range.
  fc
    .record({ octets: arbOctet4, prefix: arbGroup4, suffix: arbGroup4, force: fc.integer({ min: 1, max: 0xffff }) })
    .map(({ octets, prefix, suffix, force }) => {
      const p = prefix.slice();
      p[0] = p[0] === 0 ? force : p[0];
      return { a: mappedForms(octets), b: v6Forms([...p, ...suffix]), sameRange: false };
    }),
);

/** Either kind of pair, tagged with which it is. */
export const arbAddressPair: fc.Arbitrary<AddressPair> = fc.oneof(arbSameRangePair, arbDifferentRangePair);
