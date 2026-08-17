# Implementation Plan

## Overview

Four fixes (D2 → D4 → D1+D3 → docs), sequenced as design.md's *Implementation Sequencing* section prescribes. Two evidence-gathering tasks come first and **must run against the unfixed code**.

**Commands** (verified against `package.json`): tests `npm run test:run` (= `vitest run`), types `npm run typecheck` (= `tsc --noEmit`), Worker types `npm run types` (= `wrangler types`). Baseline before any change: 27 tests passing across 5 files, `tsc --noEmit` clean. `tsconfig.json` has `strict: false`, so the compiler only catches a forgotten argument where design.md adds an **explicit** annotation (`ctx: ExecutionContext`, `bg: Background`).

**Property numbering** follows design.md's *Correctness Properties* (1–16), not a per-task renumbering. Property 1 is the bug-condition property (token confidentiality); Property 16 is the preservation property.

---

## Tasks

- [ ] 1. Record the preservation baseline against the UNFIXED code
  - **Property 16: Preservation** - Everything outside the four bug conditions
  - **THIS TASK MUST COMPLETE AND BE COMMITTED BEFORE ANY FILE UNDER `src/` IS MODIFIED.** Reason, from design.md's *Preservation Checking* section: F (current) and F' (fixed) cannot both be loaded in one Worker isolate, so `ASSERT F(X) = F'(X)` cannot be evaluated live. Observational equality has to be captured as **recorded expectation fixtures** — run the request corpus against the current code, snapshot the observable tuple, commit it, then later assert F' reproduces it. The moment a source change lands, F no longer exists in the tree and the preservation evidence is unrecoverable.
  - Add the property-based testing dependency: `npm i -D fast-check` (design.md: `fast-check` is not currently a dependency). This is the one legitimate `package-lock.json` change in this task — the lock file is already dirty from optional-peer-dep churn while running the baseline, which is not a deliberate change and should not be conflated with this one.
  - Create `test/helpers.ts` with the two harness primitives design.md's *Validation Approach* requires, plus the tuple recorder:
    - `captureLogs()` — `vi.spyOn` on `console.log` **and** `error`/`warn`/`info` (so a stray `console.error` cannot leak), joining every captured argument into lines.
    - `expectRedactedLogPresent(lines)` — the **NON-VACUITY guard**. Asserting only "no line contains the token" passes trivially when no log line was emitted at all, so any test making that claim must ALSO assert some captured line contains `edit=[redacted]`, proving a line was emitted *and* redacted.
    - `nextIp()` — mints a distinct `cf-connecting-ip` (e.g. `198.51.100.<n>` from a per-test counter) that is sent on **every** request in a sequence. `rateLimit()` falls back to `ip = "0"` when the header is absent, so header-less requests share one `rl:0:<minute>` bucket and one `rej-ip:0` counter and would cross-contaminate every rejection-count and adaptive-cap assertion. The `"0"` fallback itself is out of scope.
    - `observe(res, env, name)` → the tuple design.md defines: HTTP status, JSON error `code`, all `x-*` headers (sorted), `location` on 302, `/raw` bytes, and `n:<name>` / `m:<name>` KV state **excluding the new `k` field**.
  - Build the corpus from design.md's *Preservation Checking* test cases 1–6, with a **fixed fast-check seed and fixed `numRuns`** so the recorded fixture is reproducible:
    1. Read path — 302 on allowlisted target (`location` = stored target), interstitial for non-allowlisted including `?go=1` not bypassing, `notePage` for text, `/raw` bytes + `content-type: text/plain;charset=utf-8`, JSON read shape, 404, 410.
    2. Body-token edits — every `content` / `ttl` / `renew` combination in `docs/API.md`, plus the "each edit resets the expiry window" semantics, plus one request carrying a body token **and** a different header token, to pin the documented body-first precedence.
    3. Error envelopes — `missing_token`, `invalid_token`, `not_editable`, `corrupt_meta`, `invalid_ttl`, `invalid_name`, `reserved_name`, `name_taken`, `url_too_long`, `text_too_long`, `malformed_url`, `rate_limited` (with `details.limit` and `details.windowSeconds: 60`), and all five gate codes in their current evaluation order.
    4. Create success — full 201 JSON field set, all `x-*` headers, `editToken` present exactly once.
    5. Admin — `/admin/stats`, `/admin/note`, `/admin/disable`, `/admin/enable`, `/admin/delete`, `/admin/config` with a valid `ADMIN_KEY`, plus the session login flow, and `/admin/enable` clearing both `d:` and `abuse:`.
    6. CORS / assets — `OPTIONS` 204 preflight on several paths, `ASSETS` serving `/llms.txt` and `/robots.txt`, and non-browser `accept` on `0g.hk` returning the plain-text manual.
  - Write the recording to `test/__fixtures__/preservation-baseline.json`; give the suite a record mode and an assert mode so the same corpus re-runs after each fix.
  - Run `npm run test:run` — the recording pass must be green on the unfixed code, and the existing 27 tests must still pass.
  - **Commit the fixture before starting task 3.** Do not modify anything under `src/` in this task.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15_

- [ ] 2. Write the exploratory bug-condition tests against the UNFIXED code
  - **Property 1: Bug Condition** - Token confidentiality (this task also surfaces the counterexamples for `isBugCondition_2`, `isBugCondition_3`, and `isBugCondition_4`)
  - **CRITICAL**: these tests MUST FAIL on the unfixed code — the failures are what confirm the root-cause analysis. **DO NOT attempt to fix the test or the code when they fail.**
  - **NOTE**: these tests encode the expected behavior, so the same tests become the fix checks in tasks 3–5. Do not rewrite them later.
  - **GOAL**: surface counterexamples. If any case *refutes* its hypothesized root cause, stop and re-hypothesize before writing any fix.
  - **Scoped PBT approach**: all eight defects here are deterministic, so scope each property to the concrete failing case(s) named below rather than generating — reproducibility matters more than domain coverage at this stage. Generated coverage arrives in task 3.
  - Test cases, from design.md's *Exploratory Bug Condition Checking*:
    1. **Token in log line (D1, 1.1/1.2)** — console spy, `SELF.fetch("https://<sub>.0g.hk/?edit=<token>&c=x")`, assert no captured line contains the token. Expected counterexample: `<-- GET /?edit=<token>&c=x`.
    2. **Header transport ignored (D1, 1.4)** — `POST /` with `X-Edit-Token` and body `{"content":"x"}`, expect 200. Expected counterexample: `400 missing_token`.
    3. **Rejection counters (D2, 1.5)** — one create with `content: "javascript:alert(1)"` from a dedicated IP, then read `rej:<day>:bad_scheme` and `rej-ip:<ip>` via `env.NOTES.get`. **A PASS HERE IS INCONCLUSIVE, NOT A REFUTATION** — the defect is timing-dependent, and if `SELF.fetch` happens to await the floating promise the assertion holds even on unfixed code. Record the observation either way and treat test case 4 as the reliable signal for D2.
    4. **Adaptive cap (D2, 1.8)** — five rejected creates then three valid creates from one fresh IP; assert at most 2 of the three are non-429. Expected counterexample: all three accepted, because `rej-ip:<ip>` never reached `ADAPTIVE_REJECT_THRESHOLD` (5). This is the authoritative D2 signal.
    5. **One /64 disables a note (D3, 1.10/1.11)** — three reports from `2001:db8::1` / `::2` / `::3`; assert `d:<name>` absent and status ≠ 410. Expected counterexample: `abuse:<name>` = 3, `d:<name>` present with a 365-day TTL, note answers 410.
    6. **Unverified report counted (D3, 1.9/1.12)** — `TURNSTILE_SECRET` set in the test env, no challenge token; assert status ≥ 400 and the counter unchanged. Expected counterexample: 200 and the counter increments (`verifyTurnstile()` has zero call sites).
    7. **Kind not persisted (D4, 1.18)** — create a note, read `m:<name>` via `env.NOTES.get`, assert a `k` field exists. Expected counterexample: `{"v":1,"h":…,"t":"7d","ct":…}` with no `k`.
    8. **Edge case — kind flip (D4, 1.16)** — create text `hello world`, edit content to `docs.example.com`, read with `redirect: "manual"`; observe the note become a redirect with no owner signal. After the fix the flip is still *allowed*, but it is recorded in `k` and only happens on an explicit content rewrite.
  - _Harness (a)_: log capture via console spy with the **non-vacuity guard** — case 1 must also assert `edit=[redacted]` appears once the fix lands, otherwise "no token in logs" passes trivially when no log line was emitted at all.
  - _Harness (b)_: a **distinct `cf-connecting-ip` per request sequence** — `rateLimit()` falls back to `ip = "0"`, so header-less requests share one `rl:0:<minute>` bucket and one `rej-ip:0` counter and would cross-contaminate the accounting in cases 3 and 4.
  - _Sequencing_: cases 3 and 4 must issue their requests **sequentially** — `recordReject`'s read-modify-write is non-atomic, so concurrent requests can lose an increment and make the assertion flaky for a reason unrelated to the defect.
  - Run `npm run test:run` and **record every failure and counterexample** in the task notes. Mark complete when the tests are written, run, and the failures documented.
  - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.8, 1.9, 1.10, 1.11, 1.12, 1.16, 1.18 (defects observed); 2.1, 2.2, 2.4, 2.8, 2.9, 2.10, 2.12, 2.17, 2.19, 2.23 (behaviors asserted)_

- [ ] 3. Add the shared property-based arbitraries
  - `fast-check` was installed in task 1; this task lands the shared generators so each fix task can consume them instead of redefining domains.
  - Create `test/arbitraries.ts`:
    - `arbToken` — base64url edit-token shapes, plus mutations (bit flip, truncation, extension, empty, wrong-length) for **Property 3**.
    - `arbQueryString` — query strings mixing secret (`edit`, `token`, `key`, `ts`) and non-secret (`c`, `n`, `ttl`, `format`) parameters, for **Property 1**.
    - `arbContent` / `arbTtl` — content bounded by `urlMax` / `textMax` so generation never wanders onto the 413 path, and `ttl ∈ {1h, 1d, 7d, ∅}` with an optional `renew`, for **Property 2**.
    - `arbAddressForms` — one address rendered in many text forms (compressed, expanded, IPv4-mapped, with zone id) plus a same-range / different-range pair generator, for **Property 8**.
    - `arbBoundaryContent` — content straddling `URL_NO_SCHEME_RE`: bare hostnames, hostnames with ports and paths, strings containing whitespace, punycode-ish labels, trailing dots — for **Properties 11, 12, 14**.
  - The corpus generator recorded in task 1 serves **Property 16**; keep its seed and `numRuns` pinned here so the fixture stays reproducible.
  - Design.md deliberately does **not** use generation for the ordered multi-request KV-counter properties (4, 5, 7, 9, 10, 13, 15) — a generator would be slow there and would fight the non-atomic increment in `recordReject`. Those stay example-based and parametrized.
  - _Requirements: supports 2.1, 2.2, 2.4, 2.17, 2.19, 2.20, 2.23, 2.24, 3.5, 3.12_

- [ ] 4. D2 — thread `ExecutionContext` and keep rejection telemetry alive
  - **Sequenced first among the fixes**: D2 touches only `fetch`, the three route closures, the handler signatures, and the 11 `recordReject` calls. It changes **no HTML**, so no snapshot moves, and it lands the new explicit type annotations early — under `strict: false` those annotations are the only compiler-level safety net for handler arity, and every later fix benefits from them being in place.

  - [ ] 4.1 Add the `Background` facade and its unit tests
    - `src/util.ts`: add `makeBackground(exeCtx)` returning `{ waitUntil(p), settle() }` — `exeCtx.waitUntil` when the platform supplied one, otherwise queue and await on `settle()`. Every queued promise is wrapped in `Promise.resolve(p).catch(ignore)` so telemetry never rejects outward.
    - Export the `Background` type so it can annotate the new handler parameters.
    - Unit tests (design.md *Unit Tests*): with a real `ExecutionContext` — `waitUntil` receives the promise and `settle()` resolves immediately; with `null` — `settle()` awaits the queued promises; a rejecting promise never propagates out of either path.
    - The `null` fallback is what makes Property 4 deterministic in unit-style tests where handlers are called directly; the response waits a few milliseconds there and never does in production.
    - _Requirements: 2.7, 2.8_

  - [ ] 4.2 Accept and forward `ExecutionContext`
    - `src/index.ts`: `fetch(req, env, ctx)` with `ctx: ExecutionContext` annotated, forwarding to `baseApp.fetch(req, env, ctx)` and `subApp.fetch(req, env, ctx)`. Forwarding is what makes `c.executionCtx` usable at all.
    - Add `safeExecutionCtx(c)` with a `try/catch` — hono's getter **throws** `"This context has no ExecutionContext"` rather than returning `undefined`.
    - Add the single choke point `withBackground(c, run)` that builds the facade and `await bg.settle()` in a `finally`, so settle happens even when a handler throws into `onError`.
    - Wire the three write routes through it: `baseApp.on(["POST","PUT"], "/")`, the `baseApp.get("/")` branch that forwards to `handleCreate` when `?c=` is present, and `subApp.all("*")`.
    - _Requirements: 2.7_

  - [ ] 4.3 Thread `bg` into the handlers and convert all 11 rejection sites
    - `src/index.ts`: signatures become `handleCreate(req, env, url, bg)`, `handleEdit(req, env, sub, url, bg)`, `handleSubdomain(req, env, host, url, bg)` (forwarding `bg` to `handleEdit`). Annotate the new parameter `bg: Background` so `npm run typecheck` reports any call site that forgets it.
    - Convert every `recordReject(env, code, ip)` to `bg.waitUntil(recordReject(env, code, ip))` — **all 11 sites**: in `handleCreate`, `brand_blocked`, `bad_scheme` (dangerous scheme), `bad_scheme` (non-http protocol), `shortener_blocked`, `unsafe_target`, `content_blocked`; in `handleEdit`, the same five minus `brand_blocked`.
    - No other site changes: design.md's floating-promise audit found `recordReject` is the only unawaited promise on the write path. `recordReject`'s internal read-modify-write stays non-atomic (pre-existing KV limitation, out of scope) — which is why the tests below must be sequential.
    - _Bug_Condition: `isBugCondition_2(input)` — `EXISTS r IN input WHERE isRejectedByGate(r)`, gate codes `brand_blocked` / `bad_scheme` / `shortener_blocked` / `unsafe_target` / `content_blocked`_
    - _Expected_Behavior: every rejection recorded exactly once, `SUM(rej:<day>:<code>) = n` and `rej-ip:<ip> = n`, with the response never waiting on the telemetry write when an `ExecutionContext` is available_
    - _Preservation: gate order, gate error codes and statuses untouched; `429 rate_limited` keeps `details.limit` and `details.windowSeconds: 60`_
    - _Requirements: 1.5, 1.6, 1.7, 1.8, 2.7, 2.8, 2.9, 2.10, 2.11, 3.8, 3.9_

  - [ ] 4.4 Write the rejection-accounting and adaptive-cap tests
    - **Property 4: Bug Condition** - Rejection accounting is exact — parametrized sequences of 1, 3, and 5 rejections mixing `bad_scheme` / `shortener_blocked` / `brand_blocked`; read counters via `env.NOTES.get`.
    - **Property 5: Bug Condition** - Adaptive cap engages — 5 rejections then 4 valid creates from one fresh IP inside one minute; assert ≤ 2 non-429 and that the 429s carry `details.limit` and `details.windowSeconds: 60`.
    - **Property 6: Bug Condition** - Telemetry never blocks or breaks — table-driven over the five gate codes, asserting status and JSON `code` against the absolute pre-fix values recorded in task 1 (not a live comparison with F).
    - **Property 11 also confirmed here indirectly**: `/admin/stats` reports counts equal to the rejections that actually occurred (2.11).
    - _Harness (a)_: console-spy log capture with the **non-vacuity guard** — any assertion of the form "the token/secret is absent from logs" must also assert `edit=[redacted]` is present, or it passes trivially when no log line was emitted at all.
    - _Harness (b)_: a **distinct `cf-connecting-ip` per sequence** via `nextIp()` — `rateLimit()` falls back to `ip = "0"`, so header-less requests share one `rl:0:<minute>` bucket and one `rej-ip:0` counter and would cross-contaminate these exact assertions.
    - _Sequencing_: Property 4's requests must be issued **SEQUENTIALLY** — `recordReject`'s read-modify-write is non-atomic, so concurrent rejections from one IP can lose an increment.
    - _Requirements: 2.8, 2.9, 2.10, 2.11, 3.8, 3.9_

  - [ ] 4.5 Verify the D2 exploratory tests now pass and nothing regressed
    - **Property 4: Bug Condition** / **Property 5: Bug Condition** — re-run the SAME exploratory cases 3 and 4 from task 2; do NOT write new tests. Case 4 is the authoritative signal (case 3 may have passed even unfixed).
    - **Property 16: Preservation** — re-run the task 1 baseline fixture in assert mode; expect no diff at all, since D2 changes no response and no stored bytes.
    - `npm run typecheck` must be clean — this is where the `bg: Background` annotation earns its keep by flagging a missed call site.
    - _Requirements: 2.8, 2.9, 2.10, 3.8, 3.9_

- [ ] 5. D4 — persist the note kind
  - **Sequenced second**: independent of D1 and D3, confined to `src/util.ts` plus four call sites plus one optional trailing `resultPage` parameter, and the existing `go=1` and allowlist-302 tests in `test/api.test.ts` are load-bearing preservation checks that must pass **unmodified**.

  - [ ] 5.1 Add `resolveKind` / `readKind` and their unit tests
    - `src/util.ts`: `resolveKind(content)` = `isUrl(content) ? "url" : "text"` (write-time authority); `readKind(meta, content)` returns `meta.k` only when it is exactly `"url"` or `"text"`, else falls back to `resolveKind(content)` (read-time authority + legacy fallback). Guarding on the two literals means a corrupt `k` degrades to today's behavior instead of an undefined branch.
    - Unit tests (design.md *Unit Tests*): `k` present and valid; present but corrupt (`k: "URL"`, `k: 1`, `k: null`); absent — and the fallback must equal `isUrl(content)` **exactly**.
    - _Requirements: 2.19, 2.21_

  - [ ] 5.2 Persist `k` on create
    - `src/index.ts` `handleCreate`: `const kind = resolveKind(rawContent); const urlMode = kind === "url";` and write `{ v: 1, h: tokenHash, t: ttlKey, ct: createdAtMs, k: kind }`.
    - **`v` stays `1`** — nothing reads `meta.v`, and the feature detection 2.21 actually needs is *presence of `k`*; a bump would add a version predicate with no reader.
    - _Requirements: 1.18, 2.19, 2.24_

  - [ ] 5.3 Handle `k` correctly on edit
    - `src/index.ts` `handleEdit`: parse the original meta once (it is currently re-parsed inline for the `ct` comparison), then — content supplied → `kind = resolveKind(content)` and `meta.k = kind`; no content supplied → `kind = readKind(meta, existingContent)` and `meta.k` left **exactly** as it was, including absent.
    - Meta rewrite guard becomes `ttlKey !== origMeta.t || meta.ct !== origMeta.ct || meta.k !== origMeta.k`, so newly-persisted `k` is not dropped by the "nothing changed, reuse the original bytes" path.
    - `urlMode`, `target`, JSON `kind`, and `x-kind` all derive from that single `kind` value.
    - **Do not** backfill `k` on TTL-only/renew edits — design.md rejects that alternative: it would change `meta.k` during an operation that supplies no content, contradicting 2.22/2.23 and falsifying Property 13 for legacy records. The 7-day maximum TTL already bounds the fallback window.
    - _Requirements: 2.22, 2.23, 2.24, 3.4_

  - [ ] 5.4 Read the persisted kind on the read path
    - `src/index.ts` `handleSubdomain`: `const kind = readKind(meta, content); const urlMode = kind === "url";` replaces `const urlMode = isUrl(content)`.
    - Keep the `parseUrlSafe(content)` guard that degrades an unparseable `"url"` note to `notePage` — kind selects the branch, the parse check stays a safety net and preserves today's behavior for that edge. `isAllowedTarget(target)` → 302 vs interstitial is untouched.
    - _Requirements: 1.14, 1.15, 2.20, 3.1, 3.2, 3.3_

  - [ ] 5.5 Collapse the remaining duplicate derivations
    - `src/admin.ts` `loadNoteDetail`: `kind: content != null ? readKind(meta, content) : null` — `meta` is already parsed there, only the derivation changes.
    - `src/views/ResultPage.tsx`: signature becomes `resultPage(name, content, mode, ttlKey, editToken, kind?)`; inside `Result`, `const link = (kind ?? resolveKind(content)) === "url"`. Both production call sites already hold `kind` and pass it. `isAllowedTarget(content)` for the whitelist warning is unchanged.
    - The parameter is **optional and trailing** so `test/views.test.ts`'s three `resultPage(...)` calls compile unchanged and their snapshots stay byte-identical.
    - This retires all five duplicate derivations (`handleCreate`, `handleEdit`, `handleSubdomain`, `loadNoteDetail`, `ResultPage`) down to `resolveKind` + `readKind`.
    - _Bug_Condition: `isBugCondition_4(input)` — `meta(input).k = UNDEFINED OR isUrl(content(input)) != (kindAtWriteTime(input) = "url")`_
    - _Expected_Behavior: `m:<name>.k ∈ {"url","text"}`, equal to the JSON `kind`, the `x-kind` header, and the branch actually taken; changed only by an explicit content rewrite_
    - _Preservation: 302-on-allowlist, interstitial with `?go=1` not bypassing, `notePage`, `/raw` bytes — all unchanged, including for legacy records with no `k`_
    - _Requirements: 1.17, 2.20, 2.24_

  - [ ] 5.6 Write the kind tests
    - **Property 11: Bug Condition** - Kind is persisted and authoritative — EX: allowlisted URL note ⇒ 302 with matching `location`; non-allowlisted URL note ⇒ interstitial; text note ⇒ `notePage`; each asserting `m:<name>.k` = JSON `kind` = `x-kind` = the observed branch. **PBT** over `arbBoundaryContent` ⇒ persisted `k` always equals the branch actually taken.
    - **Property 12: Bug Condition** - Kind is invariant across reads — **PBT**: read the note 5 times across `/`, `/raw`, `?format=json`, `/admin/note`; all reported kinds equal.
    - **Property 13: Bug Condition** - Kind survives non-content operations — EX: for a URL note, a text note, and one hand-seeded legacy record with no `k`, apply `renew=1`, `ttl=1d`, `/raw`, JSON read, HTML read; after each, the raw `m:<name>` `k` field is unchanged — same literal, or still absent for the legacy record.
    - **Property 14: Bug Condition** - Kind recomputed only on content rewrite — **PBT** over generated `(kind0Content, kind1Content)` pairs: create then edit content, assert `m:<name>.k = resolveKind(newContent)` and that the read branch follows. EX: the text → `docs.example.com` flip from exploratory case 8, now asserting the flip is recorded in `k`.
    - **Property 15: Bug Condition** - Legacy records unaffected — EX: seed `n:` + `m:` directly via `env.NOTES.put` with `{"v":1,"h":…,"t":"7d","ct":…}` (no `k`) for an allowlisted URL, a non-allowlisted URL, and plain text; assert branch and reported `kind` match pre-fix expectations. This is the only test that constructs KV state by hand.
    - _Harness (a)_: console-spy log capture with the **non-vacuity guard** — a "secret absent from logs" assertion must also assert `edit=[redacted]` is present, or it passes trivially when no log line was emitted at all.
    - _Harness (b)_: a **distinct `cf-connecting-ip` per request** via `nextIp()` — the create/edit calls in these tests pass through `rateLimit()`, which falls back to `ip = "0"`, so a shared bucket would produce spurious 429s and pollute `rej-ip:0`.
    - _Requirements: 2.19, 2.20, 2.21, 2.22, 2.23, 2.24_

  - [ ] 5.7 Verify the D4 exploratory tests now pass and nothing regressed
    - **Property 11: Expected Behavior** / **Property 14: Expected Behavior** — re-run the SAME exploratory cases 7 and 8 from task 2; do NOT write new tests.
    - **Property 16: Preservation** — re-run the task 1 baseline fixture in assert mode. The **only** permitted diff is `m:<name>` gaining `k`, which the recorded tuple already excludes; anything else is a regression.
    - The existing `go=1` bypass test and allowlist-302 test in `test/api.test.ts` must pass **unmodified** — they are the load-bearing preservation checks for D4.
    - The three `resultPage` snapshots must not move.
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 6. D1 + D3 — token out of the URL, and abuse reporting hardened
  - **Sequenced last and together**: both edit inline view JS and both move snapshots (`EditNotePage` for D1, `InterstitialPage` for D3), so pairing them means **one** intentional snapshot review instead of two. They do not otherwise overlap — D1 touches `handleEdit` + `logger`, D3 touches `handleAbuseReport` + `constants.ts`.

  - [ ] 6.1 Add the Turnstile site key binding and regenerate Worker types
    - `wrangler.toml`: add `[vars] TURNSTILE_SITEKEY = ""` (public, safe in the repo). `TURNSTILE_SECRET` stays a secret via `wrangler secret put`.
    - Run `npm run types` to regenerate `worker-configuration.d.ts`. Do this **before** 6.9 so `env.TURNSTILE_SITEKEY` is typed when `handleSubdomain` starts passing it. Note `env.TURNSTILE_SECRET` type-checks today only because handler `env` parameters are implicitly `any`.
    - _Requirements: 2.18_

  - [ ] 6.2 Add `redactLogLine` with unit and property tests
    - `src/util.ts`: `SECRET_QS_RE = /([?&](?:edit|token|key|ts)=)[^&\s]*/gi` and a pure, exported `redactLogLine(s)` replacing with `"$1[redacted]"`. `edit`/`token` cover the edit transports, `key` covers `/admin/*?key=<ADMIN_KEY>`, `ts` covers the D3 challenge token. Keeping the parameter name means the log still shows *that* a token was presented — which is also what makes the redaction non-vacuously testable.
    - Unit tests (design.md *Unit Tests*): each of `edit` / `token` / `key` / `ts` redacted in any position; parameter name preserved; non-secret parameters (`c`, `n`, `ttl`, `format`) untouched; idempotent; safe on empty and non-string input.
    - **Property 1: Bug Condition** - Token confidentiality — **PBT** over `arbToken` × `arbQueryString`: output always contains `[redacted]`, never the token, and non-secret parameters are byte-identical. This is where the real coverage for Property 1 lives.
    - _Requirements: 2.2_

  - [ ] 6.3 Redact both logger instances
    - `src/index.ts`: `baseApp.use("*", logger((m, ...r) => console.log(redactLogLine(m), ...r)))` and the same for `subApp`. hono's `logger()` builds `path = url.slice(url.indexOf("/", 8))` — path **plus** query — and hands the whole line to the print function, so this one seam covers the incoming (`<--`) and outgoing (`-->`) lines for every route, including the deprecated GET form.
    - _Requirements: 1.2, 2.2, 2.3_

  - [ ] 6.4 Accept the header transport in `handleEdit`
    - `src/index.ts`: `const token = bp.token || req.headers.get("x-edit-token") || url.searchParams.get("edit") || ""`.
    - **Body first, deliberately**: every request shape that exists today resolves to the same token it resolves to now, which makes Property 16 trivially true for legacy clients. Design.md rejects header-first because it would change the outcome for a request carrying both a body token and a different header token — an input outside every bug condition, so preservation would have to be argued rather than observed.
    - **Do not change routing.** `handleSubdomain` already sends every POST/PUT to `handleEdit`, so `POST /` with `X-Edit-Token` arrives with no new dispatch rule; `url.searchParams.has("edit")` stays as the deprecated GET entry point; a GET carrying only `X-Edit-Token` falls through to the read path exactly as today.
    - Response side unchanged: `noteMetaHeaders` emits `x-edit-token` on create only.
    - _Requirements: 1.4, 2.3, 2.4, 3.5_

  - [ ] 6.5 Rewrite the editor's `save()` to POST out-of-URL
    - `src/views/EditNotePage.tsx`: `fetch("/", { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-edit-token": token }, body: JSON.stringify({ content: c }) })`.
    - Status handling (`ok` / 403 / 429 / other), the `#t=` fragment parse, the `/raw` seeding fetch, and the Cmd/Ctrl-S binding are unchanged. The token still comes from `location.hash`, which is never sent to any server.
    - Rewrite the file's header comment: it currently describes the GET form while claiming the token never reaches server logs — this change makes the claim true.
    - _Requirements: 1.1, 2.1, 2.6, 3.7_

  - [ ] 6.6 Replace the abuse threshold constants
    - `src/constants.ts`: remove `ABUSE_AUTO_DISABLE = 3` (its only importer is `src/index.ts`) and add `ABUSE_AUTO_QUARANTINE = 10`, `QUARANTINE_MAX_TTL_SEC = 7 * 86400`, `QUARANTINE_MIN_TTL_SEC = 3600`, `ABUSE_GROUP_TTL_SEC = 30 * 86400`.
    - Rationale to preserve in a comment: after group collapsing, one unit of the counter costs one distinct /64 or /24 **and** one solved challenge, so 10 is high enough that a single residential delegation (a /56 or /48 = 256–65536 /64s) no longer buys a cheap takedown, and low enough that a genuinely abused link still trips within a day.
    - _Requirements: 1.10, 2.15_

  - [ ] 6.7 Add `reporterGroup` with unit and property tests
    - `src/util.ts`: `reporterGroup(ip)` — lowercase/trim; empty ⇒ `"v0:unknown"`; IPv6 ⇒ strip zone id, convert an embedded trailing IPv4 to two hex groups, expand `::` to exactly 8 groups, zero-pad each to 4 hex digits, return `"v6:" + first 4 groups` (/64); IPv4 ⇒ `"v4:" + first 3 octets` (/24).
    - This replaces the chained `split(":").slice(0,4)…split(".").slice(0,3)` truncation, which silently fails on compressed IPv6 — the exact reason one actor presents as three reporters.
    - Unit tests (design.md *Unit Tests*): compressed, expanded, IPv4-mapped, zone-id, IPv4, empty, and malformed inputs; /64 and /24 boundaries; stability across text forms.
    - **Property 8: Bug Condition** - One address range counts once — **PBT** over `arbAddressForms`: addresses in one /64 (or /24) in mixed text forms produce equal group strings; addresses in different ranges differ.
    - _Requirements: 1.11, 2.17, 3.12_

  - [ ] 6.8 Verify the challenge before counting, and key dedupe on the group
    - `src/responses.ts`: `readBody` gains one field so the challenge token survives parsing — `turnstile: j.ts ?? j.turnstile ?? j["cf-turnstile-response"]` for JSON, and `g("cf-turnstile-response") || g("ts") || g("turnstile")` for form bodies. Existing fields and their precedence untouched.
    - `src/index.ts` `handleAbuseReport`: read `x-turnstile-token` or the body field, call `verifyTurnstile(env, tsToken, ip)`, and on failure return `replyError(..., "challenge_failed", "Human verification failed", 403, { reason: v.reason })` — **before any read or write of the counter**, so an unverified report is fully inert. `verifyTurnstile` already returns `{ok:true}` when `TURNSTILE_SECRET` is unset and fails open on network errors, so an unconfigured deployment keeps working unchanged.
    - Dedupe key becomes `"abuse-dedupe:" + sub + ":" + (await sha256Base64Url(reporterGroup(ip))).slice(0, 12)` with TTL `ABUSE_GROUP_TTL_SEC`. The `:<day>:` segment is dropped so one group counts at most once per note per counter lifetime — which is what makes "10 distinct ranges" mean what it says. The key **prefix** is unchanged and same-day duplicates still answer `deduped: true`; stale day-scoped keys simply expire.
    - _Requirements: 1.9, 1.11, 1.12, 2.12, 2.13, 2.17, 3.12_

  - [ ] 6.9 Replace the hard disable with a bounded, reversible quarantine
    - `src/index.ts`: at `count >= ABUSE_AUTO_QUARANTINE`, write `d:<sub>` = `{ reason: "community_reports", auto: true, count, at: now, exp: now + ttl*1000 }` with `expirationTtl = ttl`, where `ttl = clamp(remainingNoteTtlSec(meta), QUARANTINE_MIN_TTL_SEC, QUARANTINE_MAX_TTL_SEC)`.
    - Add `remainingNoteTtlSec(meta)` derived from `m:<sub>` (`ct` + `TTL_OPTIONS[t]` − now), falling back to `QUARANTINE_MAX_TTL_SEC` when meta is missing or unparseable.
    - `exp` is stored **inside the payload** because KV does not expose a record's remaining TTL on read — it is what makes the bound observable to the 410 page, the admin detail view, and Property 10's test.
    - The key stays `d:<sub>`, so the 410 read path and `/admin/enable`'s `delete("d:"+name)` + `delete("abuse:"+name)` keep working with no change.
    - Owner recourse: for `auto: true` markers only, the 410 status page gains the auto-expiry timestamp and an appeal line naming `ABUSE_EMAIL`, and the JSON 410 gains `details.auto` and `details.until`. Status (`410`) and error `code` (`disabled`) are unchanged for both auto and admin markers. **No self-serve un-quarantine endpoint** — for a genuinely malicious note the token holder *is* the abuser, so token-gated self-clearing would defeat the mechanism; the documented path is expiry-plus-appeal.
    - Unit tests (design.md *Unit Tests*): the quarantine TTL clamp — `remainingNoteTtlSec` for `1h` / `1d` / `7d` notes at several ages, for missing meta, and for corrupt meta; the result is always within `[QUARANTINE_MIN_TTL_SEC, QUARANTINE_MAX_TTL_SEC]`.
    - _Requirements: 1.10, 1.13, 2.15, 2.16, 3.11, 3.13_

  - [ ] 6.10 Wire the optional challenge widget into the interstitial
    - `src/views/InterstitialPage.tsx`: signature becomes `interstitialPage(sub, target, siteKey?)`. When `siteKey` is present, render the `challenges.cloudflare.com/turnstile/v0/api.js` script tag plus `<div class="cf-turnstile" data-sitekey={siteKey} data-action="abuse-report">` inside the warn card. Extend `REPORT_JS` to read the widget's hidden `cf-turnstile-response` input when present and POST `{"turnstile": <token>}` as JSON.
    - `handleSubdomain` passes `env.TURNSTILE_SITEKEY`. The parameter is optional so `test/views.test.ts` compiles unchanged.
    - **No CSP change** — the existing CSP already allows `challenges.cloudflare.com` in `script-src`, `frame-src`, and `connect-src`. `REPORT_JS` stays inline.
    - _Requirements: 2.18_

  - [ ] 6.11 Write the D1 and D3 tests
    - **Property 1: Bug Condition** - Token confidentiality — EX console-spy integration test per transport (header POST, body POST, deprecated GET), asserting the token is absent from logs, response headers, and body.
    - **Property 2: Bug Condition** - Transport equivalence — **PBT** over `arbContent` × `arbTtl` × optional `renew`: create three notes, edit one via header, one via body, one via query; equal status and equal `/raw` bytes across all three. Also assert `GET` + `X-Edit-Token` performs a plain read with no mutation.
    - **Property 3: Bug Condition** - No forged token authenticates — **PBT** over `arbToken` mutations: status ∈ {400, 403} on all three transports and `/raw` unchanged; empty ⇒ 400 `missing_token`, non-empty ⇒ 403 `invalid_token`.
    - **Property 7: Bug Condition** - Sub-threshold reports never disable — EX parametrized for `n ∈ {1, 5, 9}` from `n` distinct /64s: `d:<name>` absent, subdomain status ≠ 410, `abuse:<name>` = n.
    - **Property 8: Bug Condition** - One address range counts once — EX: 4 reports from `2001:db8::1`, `2001:db8:0:0::2`, `2001:0db8:0000:0000:0000:0000:0000:0003`, `2001:db8::4` ⇒ `abuse:<name>` ≤ 1, `deduped: true` on reports 2–4, `d:<name>` absent.
    - **Property 9: Bug Condition** - Unverified reports are inert — EX across two env shapes: secret unset ⇒ accepted and counter increments; secret set with a missing or invalid token ⇒ status ≥ 400 with counter and `d:` unchanged. Cover the `verifyTurnstile` fail-open-on-network-error branch **explicitly** so it is a known, deliberate behavior. Plus an integration check that the interstitial report control still round-trips.
    - **Property 10: Bug Condition** - Automatic action is reversible and bounded — EX: drive the counter to threshold from 10 distinct /64s; assert `d:<name>` exists with `auto: true` and payload `exp − at ≤ QUARANTINE_MAX_TTL_SEC * 1000`; assert 410 with JSON code `disabled`; then `/admin/enable` and assert both keys gone and status ≠ 410.
    - Integration tests from design.md: full editor round-trip (create → `/edit#t=<token>` → seed from `/raw` → POST save with the header transport → re-read `/raw`), with `console.log` captured throughout and asserted token-free; deprecated-transport round-trip (`GET /?edit=…` and `POST /?edit=…` both still mutate, same status and body as before, only redacted log lines); abuse flow end-to-end (interstitial → report → below threshold readable → at threshold 410 with `auto: true` and appeal text → `/admin/enable` → readable again).
    - _Harness (a)_: log capture via console spy with the **NON-VACUITY guard** — the deprecated-GET test must also assert some captured line contains `edit=[redacted]`, otherwise "no token in logs" passes trivially when no log line was emitted at all. Spy on `error`/`warn`/`info` too so a stray `console.error` cannot leak.
    - _Harness (b)_: a **distinct `cf-connecting-ip` per request** via `nextIp()` — `rateLimit()` falls back to `ip = "0"`, so header-less requests share one `rl:0:<minute>` bucket and one `rej-ip:0` counter and would cross-contaminate the report-count and rate-limit assertions. Report tests additionally need controlled addresses per reporter group, so the header is load-bearing twice over here.
    - _Sequencing_: any sequence that trips a gate must be issued **sequentially** — `recordReject`'s read-modify-write is non-atomic.
    - _Bug_Condition: `isBugCondition_1(input)` — token in the request URL or in an emitted log line; `isBugCondition_3(input)` — an unverified report, or `AUTO_ACTION_THRESHOLD` reports from a single reporter group_
    - _Expected_Behavior: no log line, response header, or body contains the token; all three transports validate identically; unverified reports are inert; the auto-action is bounded by `QUARANTINE_MAX_TTL_SEC` and cleared by `/admin/enable`_
    - _Preservation: `missing_token` 400 / `invalid_token` 403 / `not_editable` 403 / `corrupt_meta` 500 envelopes; body-token precedence; the `#t=` edit link; `deduped: true`; 410 + `disabled`; `/admin/enable` clearing both keys_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.12, 2.13, 2.14, 2.15, 2.16, 2.17, 2.18, 3.5, 3.7, 3.11, 3.12, 3.13_

  - [ ] 6.12 Verify the D1 and D3 exploratory tests now pass and nothing regressed
    - **Property 1: Expected Behavior** / **Property 8: Expected Behavior** / **Property 9: Expected Behavior** — re-run the SAME exploratory cases 1, 2, 5, and 6 from task 2; do NOT write new tests.
    - **Property 16: Preservation** — re-run the task 1 baseline fixture in assert mode. Admin responses in particular must be untouched: the `?key=` redaction changes log output only, never the response.
    - _Requirements: 2.1, 2.2, 2.4, 2.12, 2.17, 3.5, 3.10, 3.13, 3.14, 3.15_

- [ ] 7. Review the intentional snapshot churn
  - **DO NOT run `npx vitest run -u` (or `npm run test:run -- -u`) before reading the diff.** Read the failing diff in `test/__snapshots__/views.test.ts.snap` first, confirm each change against the checklist below, and only then regenerate. Blind regeneration would silently accept a token left in a URL.
  - **`editNotePage`** — verify: `save()` uses `method:"POST"`; the token appears **only** as the value of the `x-edit-token` request header inside the script and **never** inside any URL string (no `"/?edit="`, no `encodeURIComponent(token)` in a URL position); the content moves to a JSON body; the `#t=` fragment parse, the `/raw` seeding fetch, the 403/429 status messages, and the Cmd/Ctrl-S binding are all unchanged; the header comment no longer describes the GET form.
  - **`interstitialPage`** — verify: with no `siteKey` (the shape the existing snapshot exercises) the only diff is the extended `REPORT_JS`, which reads `cf-turnstile-response` defensively and still POSTs to `/abuse/report`; the confirm dialog, the target/host display, and `rel="noopener noreferrer nofollow"` on the continue link are unchanged.
  - **Add a second `interstitialPage` snapshot case WITH a `siteKey`** to pin the widget markup: the `challenges.cloudflare.com/turnstile/v0/api.js` script tag and the `cf-turnstile` div with the correct `data-sitekey`. Both are already permitted by the existing CSP, so no CSP line should appear in the diff.
  - **The three `resultPage` snapshots must stay byte-identical.** The new `kind` parameter is optional and trailing and the test's calls omit it, so the rendered HTML cannot change. **A `resultPage` snapshot diff is a signal that something unintended changed** — stop and find out what before regenerating.
  - _Requirements: 2.1, 2.6, 2.18, 3.7_

- [ ] 8. Bring the documentation back in line
  - Sequenced last, once the accepted transports and the final threshold are settled — doing this earlier means rewriting it.
  - `docs/API.md`: change the route-table row `POST <sub>.0g.hk/?edit=tk` to document `POST <sub>.0g.hk/` with `X-Edit-Token` (or body `token`) as preferred, and mark `?edit=` **deprecated but supported**; update the four `?edit=$TOKEN` curl examples in 编辑 / 续期 to the header form, keeping one deprecated example labelled as such; annotate the 浏览器兼容 entry `GET <sub>.0g.hk/?edit=tk&c=new` to note it still works and is redacted from logs; add the abuse/quarantine section covering the new threshold, group collapsing, the bounded marker, and the appeal path.
  - `public/llms.txt`: the edit example already uses the body form and stays valid — add one line naming `X-Edit-Token` as the header alternative, and update the abuse/rate lines if they cite the old threshold.
  - `public/llms-full.txt`: add the same header alternative in the edit sections, and rewrite the `Report abuse … After ABUSE_AUTO_DISABLE (3) reports the note …` line (~line 98) to describe the group-based threshold, the challenge, and the bounded reversible quarantine.
  - _Requirements: 2.5_

- [ ] 9. Checkpoint — full verification
  - `npm run test:run` — all tests green, including the original 27 unmodified, with the `go=1` bypass test and the allowlist-302 test in `test/api.test.ts` passing **without edits**.
  - `npm run typecheck` — clean. Under `strict: false` this only catches arity on the newly annotated parameters (`ctx: ExecutionContext`, `bg: Background`), which is precisely why they were annotated.
  - **Property 16: Preservation** — the task 1 baseline fixture reproduces exactly, with `m:<name>.k` as the only excluded field.
  - Confirm **every Property 1–16 is covered by at least one test**, and record where: 1 → 6.2 (PBT) + 6.11 (EX); 2 → 6.11; 3 → 6.11; 4 → 4.4; 5 → 4.4; 6 → 4.4; 7 → 6.11; 8 → 6.7 (PBT) + 6.11 (EX); 9 → 6.11; 10 → 6.11; 11 → 5.6; 12 → 5.6; 13 → 5.6; 14 → 5.6; 15 → 5.6; 16 → task 1 fixture, re-asserted in 4.5, 5.7, 6.12. Any property with no entry is a gap, not a judgement call.
  - Confirm the unit tests design.md enumerates all exist: `redactLogLine` (6.2), `reporterGroup` (6.7), `resolveKind` / `readKind` (5.1), `makeBackground` (4.1), quarantine TTL clamp (6.9).
  - Ensure all tests pass; ask the user if questions arise.
  - _Requirements: all of 2.1–2.24 and 3.1–3.15_

- [ ] 10. Optional / deferred — explicitly not part of this fix
  - [ ] 10.1 *(Optional, follow-up)* Remove the legacy `k`-absent fallback in `readKind` once the 7-day TTL window since deploy has expired
    - Design.md's *Backward Compatibility* section: every `m:<name>` written by the current code is gone at most 7 days after deploy, at which point the `isUrl(content)` fallback is dead code. Removing it earlier would break 2.21 and Property 15.
    - _Requirements: 2.21 (bounds the window; removal is out of scope for this fix)_
  - [ ] 10.2 *(Optional, explicitly excluded)* The two pre-existing doc drifts in `public/llms-full.txt`
    - `401 invalid_token` where the code returns `403`, and `editUrl` shown without the `#t=` fragment. Design.md's *Documentation Consistency* section notes both and excludes them from scope; fix them only if the user asks.
    - _Requirements: none — outside 2.5's scope_

## Notes

**Out of scope for every task above** (design.md names these deliberately, so do not drift into them): moving inline page JS to the `ASSETS` binding or removing `'unsafe-inline'` from `script-src`; fixing the `cf-connecting-ip` fallback-to-`"0"` rate-limit bucket; making `recordReject`'s increment atomic; reformatting `src/admin.ts`; enabling `tsconfig` strict mode. Clearing pre-existing 365-day `d:<name>` markers is an operational task, not a code path.

---

## Task Dependency Graph

```
1. Preservation baseline (UNFIXED code)          ← MUST BE FIRST; no src/ changes
   │  installs fast-check, creates test/helpers.ts, commits the fixture
   ├──► 2. Exploratory bug-condition tests (UNFIXED code)
   │       │  8 cases; case 3 inconclusive, case 4 authoritative for D2
   │       │
   │       └──► 3. Shared fast-check arbitraries
   │                │
   │                ├──► 4. D2  ctx threading + Background + 11 recordReject sites
   │                │        (no HTML → no snapshot movement; lands the
   │                │         ctx/bg annotations the later fixes rely on)
   │                │         4.1 → 4.2 → 4.3 → 4.4 → 4.5
   │                │                │
   │                │                ▼
   │                ├──► 5. D4  persist meta.k, resolveKind/readKind,
   │                │        collapse the 5 duplicate derivations
   │                │         5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6 → 5.7
   │                │                │
   │                │                ▼
   │                └──► 6. D1 + D3  (paired: both edit inline view JS,
   │                         both move snapshots → one review)
   │                         6.1 → {6.2 → 6.3, 6.4 → 6.5}
   │                                {6.6 → 6.7 → 6.8 → 6.9 → 6.10}
   │                                → 6.11 → 6.12
   │                                   │
   │                                   ▼
   │                              7. Snapshot review (read the diff BEFORE -u)
   │                                   │
   │                                   ▼
   │                              8. Docs (transports + threshold now settled)
   │                                   │
   └───────────────────────────────────┴──► 9. Checkpoint: full verification
                                                 │
                                                 └──► 10. Optional / deferred
```

Hard edges: **1 before every source change** (the baseline is otherwise unrecoverable). **2 before 4/5/6** (a counterexample that never failed proves nothing). **6.1 before 6.10** (`env.TURNSTILE_SITEKEY` must be typed before it is read). **6 before 7** (nothing to review until both view files have moved). **6 before 8** (docs describe the final transports and threshold). **4.5 / 5.7 / 6.12 each re-assert task 1's fixture**, so a regression is caught by the fix that introduced it rather than at the end.

### Waves

Nearly every wave below holds a single top-level task, because the hard edges above admit almost no
parallelism among the fixes: tasks 4 (D2), 5 (D4), and 6 (D1+D3) touch mostly disjoint files but
design.md's *Implementation Sequencing* deliberately orders them D2 → D4 → D1+D3, so they must not
be collapsed into one wave. The single exception is wave 7, where tasks 7 and 8 both depend only on
task 6 and have no edge between them.

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["1"],
      "depends_on": [],
      "parallel": false,
      "rationale": "Preservation baseline against UNFIXED code. Must complete and be committed before ANY source change — F and F' cannot coexist in one isolate, so once src/ moves the baseline is unrecoverable."
    },
    {
      "wave": 2,
      "tasks": ["2"],
      "depends_on": ["1"],
      "parallel": false,
      "rationale": "Exploratory bug-condition tests against UNFIXED code. Must precede tasks 4/5/6 — a counterexample that never failed proves nothing."
    },
    {
      "wave": 3,
      "tasks": ["3"],
      "depends_on": ["2"],
      "parallel": false,
      "rationale": "Shared fast-check arbitraries. Consumes the fast-check install from task 1 and the domains confirmed by task 2's counterexamples."
    },
    {
      "wave": 4,
      "tasks": ["4"],
      "depends_on": ["2", "3"],
      "parallel": false,
      "rationale": "D2 — ctx threading, Background facade, 11 recordReject sites. Sequenced FIRST among the fixes by design.md: no HTML change, and it lands the ctx/bg annotations later fixes rely on. Internally strictly ordered 4.1 → 4.2 → 4.3 → 4.4 → 4.5."
    },
    {
      "wave": 5,
      "tasks": ["5"],
      "depends_on": ["4"],
      "parallel": false,
      "rationale": "D4 — persist meta.k. NOT parallel with wave 4 despite disjoint files: design.md's Implementation Sequencing prescribes D2 → D4 → D1+D3. Internally strictly ordered 5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6 → 5.7."
    },
    {
      "wave": 6,
      "tasks": ["6"],
      "depends_on": ["5"],
      "parallel": false,
      "rationale": "D1 + D3 — paired because both edit inline view JS and both move snapshots, giving one intentional review. NOT parallel with waves 4/5 per the prescribed D2 → D4 → D1+D3 order. Intra-task hard edge: 6.1 before 6.10, since env.TURNSTILE_SITEKEY must be typed before handleSubdomain reads it."
    },
    {
      "wave": 7,
      "tasks": ["7", "8"],
      "depends_on": ["6"],
      "parallel": true,
      "rationale": "The only genuinely parallel wave. Task 7 (snapshot review) needs both view files moved; task 8 (docs) needs the final transports and threshold settled. Both depend only on task 6 and have no edge between them."
    },
    {
      "wave": 8,
      "tasks": ["9"],
      "depends_on": ["7", "8"],
      "parallel": false,
      "rationale": "Checkpoint — full verification. Last by definition: green suite, clean typecheck, task 1 fixture reproduced, and every Property 1–16 confirmed covered."
    },
    {
      "wave": 9,
      "tasks": ["10"],
      "depends_on": ["9"],
      "parallel": false,
      "optional": true,
      "rationale": "Optional / deferred and explicitly NOT part of this fix. 10.1 is gated on the 7-day TTL window since deploy expiring; 10.2 is excluded from scope unless the user asks. Skipping this wave entirely leaves the fix complete."
    }
  ]
}
```
