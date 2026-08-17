# Write-Path Security Hardening Bugfix Design

## Overview

Four defects on the note write path are fixed together because they share one request lifecycle (`fetch` → `baseApp`/`subApp` → `handleCreate` / `handleEdit` / `handleSubdomain` / `handleAbuseReport`) and one storage layout (`n:` / `m:` / `d:` / `abuse:` / `rej:`).

| Fix | Defect | Strategy |
|-----|--------|----------|
| **D1** | Edit token in the URL of a state-mutating GET (1.1–1.4) | Add an out-of-URL transport (`X-Edit-Token` header) and switch the editor page's `save()` to `POST` with a JSON body. Keep `?edit=` accepted as a deprecated transport, and redact secret query parameters from every emitted log line by wrapping hono's `logger()` print function. |
| **D2** | `recordReject()` fires and forgets (1.5–1.8) | Accept `ctx: ExecutionContext` in the exported `fetch`, forward it to `app.fetch`, and hand each write handler a small `Background` facade (`waitUntil` + `settle`) that uses `ctx.waitUntil` when available and awaits pending writes when it is not. |
| **D3** | `/abuse/report` can take down any note (1.9–1.13) | Wire the already-implemented `verifyTurnstile()` into the report path, collapse reporters to a canonical IPv6 /64 or IPv4 /24 group, raise the auto-action threshold from 3 to 10 distinct groups, and replace the 365-day hard disable with a bounded, reversible quarantine. |
| **D4** | Note kind is never persisted (1.14–1.18) | Persist `k: "url" \| "text"` in `m:<name>` at write time, read it back through one shared accessor, fall back to `isUrl(content)` only when `k` is absent, and delete the four duplicate derivations. |

The four fixes are independent at runtime; D1 and D3 both touch inline view JS, so they share snapshot churn (see *Implementation Sequencing*).

Guiding constraint: `tsconfig.json` has `strict: false` / `noImplicitAny: false` / `strictNullChecks: false`, so most handler parameters are implicitly `any` and the compiler will not catch a forgotten new argument. The design therefore adds **explicit type annotations to the new parameters only** (`ctx: ExecutionContext`, `bg: Background`), which makes `tsc --noEmit` enforce arity at every call site without turning on project-wide strictness.

## Glossary

- **Bug_Condition (C)** — the predicate identifying inputs that trigger a defect; four instances, `isBugCondition_1..4`, one per defect.
- **Property (P)** — the required behavior for inputs satisfying C; enumerated in *Correctness Properties*.
- **Preservation** — observational equality between the current code (**F**) and the fixed code (**F'**) for every input outside all four bug conditions, compared over: HTTP status, JSON error `code`, all `x-*` metadata headers, `location` on 302, `/raw` bytes, and the resulting `n:<name>` / `m:<name>` KV state excluding the new `k` field.
- **`handleEdit(req, env, sub, url, bg)`** — `src/index.ts`, applies content/TTL/renew edits after verifying the edit token against `meta.h`.
- **`handleCreate(req, env, url, bg)`** — `src/index.ts`, creates `n:`/`m:` records and mints the edit token.
- **`handleSubdomain(req, env, host, url, bg)`** — `src/index.ts`, the read path plus dispatch to edit/abuse; owner of the redirect-vs-interstitial-vs-render branch.
- **`handleAbuseReport(req, env, sub, url)`** — `src/index.ts`, community reporting and the auto-action.
- **`recordReject(env, code, ip)`** — `src/util.ts`, two KV read-modify-writes: `rej:<yyyymmdd>:<code>` (30-day stats) and `rej-ip:<ip>` (15-minute adaptive window).
- **`Background`** — new facade `{ waitUntil(p): void; settle(): Promise<void> }` returned by `makeBackground(exeCtx)` in `src/util.ts`.
- **Token transport** — how an edit token reaches the Worker: body `token` (existing), `X-Edit-Token` header (new), `?edit=` query parameter (existing, deprecated).
- **Reporter group** — the canonical address range that owns an abuse report: IPv6 `/64` (first four 16-bit groups of the *expanded* address) or IPv4 `/24` (first three octets).
- **Quarantine** — the auto-action written to `d:<name>` with `auto: true` and a bounded `expirationTtl`, cleared by `/admin/enable` exactly like an admin disable.
- **`meta.k`** — persisted note kind in `m:<name>`; absent on every record written by F.

## Bug Details

### Bug Condition 1 — edit token in a URL or a log line

`EditNotePage`'s `save()` issues `GET /?edit=<token>&c=<content>`. hono's `logger()` logs `url.slice(url.indexOf("/", 8))` — path **and** query string — so the token lands in Worker logs, and Cloudflare request logs record the same URL. `handleEdit` reads the token only from the parsed body or `url.searchParams.get("edit")`, so a header transport is silently ignored, and `handleSubdomain` routes on `url.searchParams.has("edit")`, which makes the mutation reachable by GET.

**Formal Specification:**
```
FUNCTION isBugCondition_1(input)
  INPUT: input of type EditRequest
  OUTPUT: boolean

  RETURN input.token != NULL
         AND (tokenInRequestUrl(input)
              OR tokenInLogLine(emitLog(input)))
END FUNCTION
```

### Bug Condition 2 — a gate rejection whose telemetry write is not kept alive

Eleven call sites (six in `handleCreate`, five in `handleEdit`) invoke `recordReject(env, code, ip)` with no `await` and no `ctx.waitUntil`; the exported `fetch(req, env)` never receives `ExecutionContext`, so nothing can keep the promise alive after the response is returned.

**Formal Specification:**
```
FUNCTION isBugCondition_2(input)
  INPUT: input of type Sequence[WriteRequest]
  OUTPUT: boolean

  RETURN EXISTS r IN input WHERE isRejectedByGate(r)
         // gate codes: brand_blocked, bad_scheme,
         // shortener_blocked, unsafe_target, content_blocked
END FUNCTION
```

### Bug Condition 3 — an abuse report that is unverified or single-actor

`POST /abuse/report` has no authentication, no challenge, and no CSRF check; `verifyTurnstile()` has zero call sites. The reporter key is `sha256(ip.split(":").slice(0,4).join(":").split(".").slice(0,3).join("."))`, which truncates correctly only for *uncompressed* IPv6 — `2001:db8::1` and `2001:db8::2` tokenize to four parts that already cover the whole address, so they hash as two distinct reporters inside one /64. Three such reporters reach `ABUSE_AUTO_DISABLE = 3` and write `d:<sub>` with `expirationTtl: 365 * 86400`.

**Formal Specification:**
```
FUNCTION isBugCondition_3(input)
  INPUT: input of type Sequence[AbuseReport] for a single name
  OUTPUT: boolean

  RETURN (EXISTS r IN input WHERE NOT challengeVerified(r))
         OR (COUNT(distinctReporterGroups(input)) = 1
             AND LENGTH(input) >= AUTO_ACTION_THRESHOLD)
END FUNCTION
```

### Bug Condition 4 — kind not persisted, or read-time derivation disagrees with write time

`m:<name>` stores `{v, h, t, ct}` only. Five sites re-derive kind from content: `handleCreate`, `handleEdit`, `handleSubdomain`, `admin.ts` `loadNoteDetail`, and `ResultPage.tsx`. `URL_NO_SCHEME_RE` is the sole judge of whether a note becomes a 302 redirect.

**Formal Specification:**
```
FUNCTION isBugCondition_4(input)
  INPUT: input of type Note
  OUTPUT: boolean

  RETURN meta(input).k = UNDEFINED
         OR (isUrl(content(input)) != (kindAtWriteTime(input) = "url"))
END FUNCTION
```

### Examples

- **C1, editor save** — `GET /?edit=Ab3-x9_Q&c=hello`. Expected: token never in the URL and never in a log line; actual: `<-- GET /?edit=Ab3-x9_Q&c=hello` is printed by `logger()` and the same URL reaches Cloudflare request logs.
- **C1, header ignored** — `POST /` with `X-Edit-Token: Ab3-x9_Q` and body `{"content":"x"}`. Expected: 200 and content updated; actual: 400 `missing_token`, because only body/query are read.
- **C1, GET mutates** — a browser prefetch or history replay of `/?edit=<token>&c=…` rewrites the note. Expected: only POST/PUT mutate for non-deprecated transports; actual: GET mutates.
- **C2, rejection lost** — one create with `content: "javascript:alert(1)"` returns 400 `bad_scheme`. Expected: `rej:<day>:bad_scheme` = 1 and `rej-ip:<ip>` = 1; actual: both may stay 0 because the Worker is reclaimed before the KV writes land.
- **C2, adaptive cap never engages** — five rejected creates from one IP followed by three accepted ones. Expected: `rej-ip:<ip>` = 5 and the cap tightens to 2/min; actual: `rej-ip:<ip>` under-counts and the full 10/min budget stays.
- **C3, one /64 disables a note** — reports from `2001:db8::1`, `2001:db8::2`, `2001:db8::3` (one /64, one actor). Expected: one reporter, no auto-action; actual: three distinct reporters, `d:<sub>` written for 365 days, note answers 410.
- **C3, challenge bypassed** — `POST /abuse/report` with `TURNSTILE_SECRET` set and no challenge token. Expected: rejected with no counter change; actual: 200 and the counter increments.
- **C4, text served as a redirect** — content `example.com/hello` stored as a text note. Expected: whatever kind was resolved at write time; actual: `URL_NO_SCHEME_RE` matches at every read, so it is normalized and served as a redirect target.
- **C4, kind flips silently** — edit a URL note's content to `read the docs at docs.example.com` (no whitespace variant `docs.example.com`) and the note flips between redirect and rendered page with no signal to owner or reader.
- **C4, self-disagreement** — `admin.ts` `loadNoteDetail` reports `kind` from raw stored content while `ResultPage.tsx` computes it from the post-normalization string; nothing guarantees the two agree with the read-time branch.
- **Edge case, legacy record** — a `m:<name>` written before this fix has no `k`. Expected: behaves exactly as it does today via the `isUrl(content)` fallback; the fallback window is bounded by the 7-day maximum TTL.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Body-token edits (`{"content","ttl","renew","token"}` over JSON, form, or `text/plain`) keep the same status codes, JSON envelope, and "each edit resets the expiry window" semantics (3.4).
- `missing_token` (400), `invalid_token` (403), `not_editable` (403), `corrupt_meta` (500) keep their codes, statuses, and envelopes (3.5).
- Create success keeps `201`, all JSON fields, all `x-*` headers, and returns `editToken` exactly once (3.6).
- The read branch is unchanged for every existing note: allowlisted target → 302 with `location` = stored target; non-allowlisted → interstitial, and `?go=1` still does not bypass it; text → `notePage`; `/raw` → stored bytes with `text/plain;charset=utf-8` (3.1–3.3).
- Gate order and gate error codes/statuses are untouched; `429 rate_limited` keeps `details.limit` and `details.windowSeconds: 60` (3.8, 3.9).
- `/exists` shapes, static-asset serving via `ASSETS`, and the `OPTIONS` 204 preflight are untouched (3.10, 3.14, 3.15).
- A disabled note still answers `410` with JSON code `disabled` and the styled status page; `/admin/enable` still clears both `d:<name>` and `abuse:<name>`; duplicate reports still answer `deduped: true` (3.11–3.13).
- The edit link stays `https://<name>.0g.hk/edit#t=<token>`; the fragment is still never sent to a server; the page still seeds from `/raw` and still saves on click and on Cmd/Ctrl-S (3.7).

**Scope:**
Every input that does not satisfy one of the four bug conditions must be completely unaffected. That includes:
- Reads of any kind (`/`, `/raw`, `/edit`, JSON mode, 302, interstitial, 404, 410).
- Body-token edits, which keep their existing precedence over the query parameter.
- Accepted creates and edits — no gate trips, so no telemetry path is entered.
- Admin endpoints and the admin session flow.
- `GET` requests carrying `X-Edit-Token`: F ignores the header and serves a plain read, so **F' must also serve a plain read** — the header transport is honored only on POST/PUT (2.3). This falls out of preservation, not from a separate policy.

## Hypothesized Root Cause

1. **Transport coupling in the editor page (D1)** — `save()` was written as a single-URL GET because it is the shortest thing that works from inline JS; nothing forced the token out of the URL, and hono's default `logger()` prints the raw path+query, so the leak is a direct consequence. Confirmed by reading `node_modules/hono/dist/middleware/logger/index.js`: `const path = url.slice(url.indexOf("/", 8))`, and `logger(fn = console.log)` accepts a custom print function — which is the whole redaction seam.
2. **Missing `ExecutionContext` plumbing (D2)** — the exported `fetch` was written as `(req, env)`; because `strict: false` makes every handler parameter `any`, nothing ever complained. `recordReject` returns a promise that no one holds, and its own `try/catch` swallows the cancellation, so the failure is silent. Hono can supply `c.executionCtx`, but only if `ctx` is forwarded to `app.fetch(req, env, ctx)` — and the getter **throws** `"This context has no ExecutionContext"` when it was not, so any access needs guarding.
3. **Reporting built for a friendly world (D3)** — the report path was added as a one-click convenience, and `ABUSE_AUTO_DISABLE = 3` with a 365-day marker treats three reports as proof. The dedupe truncation additionally assumes uncompressed IPv6 text, which `cf-connecting-ip` does not provide. `verifyTurnstile()` was implemented ahead of the UI and then never wired in, so the mitigation already exists and is unused.
4. **Kind treated as a pure function of content (D4)** — `isUrl()` is cheap and deterministic *for a fixed regex*, so re-deriving looked free. It is not: the derivation is duplicated in five places, it makes a security-relevant branch depend on a heuristic that can change between deploys, and it gives the owner no stable contract. Nothing reads `meta.v`, so the meta record was never versioned in a way that would have forced this to be written down.

## Correctness Properties

Property 1: Bug Condition - Token confidentiality

_For any_ edit request whose token is carried in the request URL, or whose emitted log line would contain the token, the fixed code SHALL emit no log line, no response header, and no response body containing a value equal to the token.

**Validates: Requirements 2.1, 2.2, 2.6**

Property 2: Bug Condition - Transport equivalence

_For any_ `(name, token, content, ttl)`, the fixed code SHALL return the same status for the token presented via `X-Edit-Token` header (POST), via body `token` (POST), and via the deprecated `?edit=` query parameter, and SHALL leave identical stored content in all three cases; the header transport SHALL be honored only on POST/PUT.

**Validates: Requirements 2.3, 2.4, 3.4**

Property 3: Bug Condition - No forged token authenticates

_For any_ `(name, realToken, forged)` with `forged != realToken`, the fixed code SHALL answer `400` or `403` on every transport and SHALL leave `n:<name>` unchanged.

**Validates: Requirements 3.5**

Property 4: Bug Condition - Rejection accounting is exact

_For any_ request sequence from a single IP containing `n` gate rejections, the fixed code SHALL leave `SUM(rej:<day>:<code>)` over `REJECT_CODES` equal to `n` and `rej-ip:<ip>` equal to `n`.

**Validates: Requirements 2.8, 2.9, 2.11**

Property 5: Bug Condition - Adaptive cap engages

_For any_ request sequence from a single IP containing at least `ADAPTIVE_REJECT_THRESHOLD` (5) gate rejections, the fixed code SHALL accept at most `ADAPTIVE_RATE_LIMIT` (2) subsequent same-minute write requests from that IP and SHALL answer `429 rate_limited` to the rest.

**Validates: Requirements 2.10**

Property 6: Bug Condition - Telemetry never blocks or breaks the response

_For any_ request sequence containing a gate rejection, the fixed code SHALL return the same HTTP status and the same JSON error `code` as the current code, and SHALL NOT make the response wait on a telemetry write when an `ExecutionContext` is available.

**Validates: Requirements 2.7, 3.8**

Property 7: Bug Condition - Sub-threshold reports never disable

_For any_ `n < AUTO_ACTION_THRESHOLD` reports for one name from `n` distinct verified reporter groups, the fixed code SHALL leave `d:<name>` absent, SHALL keep the note's status different from `410`, and SHALL leave `abuse:<name>` equal to `n`.

**Validates: Requirements 2.14**

Property 8: Bug Condition - One address range counts once

_For any_ report sequence whose addresses all fall in a single IPv6 /64 or IPv4 /24, the fixed code SHALL leave `abuse:<name>` at most 1 and SHALL leave `d:<name>` absent, regardless of address text form (compressed, expanded, or IPv4-mapped).

**Validates: Requirements 2.17, 3.12**

Property 9: Bug Condition - Unverified reports are inert

_For any_ report submitted while `TURNSTILE_SECRET` is configured and the challenge does not verify, the fixed code SHALL answer status `>= 400`, SHALL leave `abuse:<name>` unchanged, and SHALL leave `d:<name>` absent; when `TURNSTILE_SECRET` is not configured the challenge SHALL no-op and the report SHALL be accepted as it is today.

**Validates: Requirements 2.12, 2.13, 2.18**

Property 10: Bug Condition - Automatic action is reversible and bounded

_For any_ report sequence that triggers the auto-action, the fixed code SHALL write a `d:<name>` marker whose lifetime is at most `QUARANTINE_MAX_TTL_SEC` (7 days), and after `/admin/enable` both `d:<name>` and `abuse:<name>` SHALL be absent and the note's status SHALL differ from `410`.

**Validates: Requirements 2.15, 2.16, 3.13**

Property 11: Bug Condition - Kind is persisted and authoritative

_For any_ note created by the fixed code, `m:<name>.k` SHALL be `"url"` or `"text"`, SHALL equal the response JSON `kind` and the `x-kind` header, and SHALL be the value that selects the read branch (`"url"` → 302 when the target is allowlisted, else interstitial; `"text"` → rendered note page).

**Validates: Requirements 2.19, 2.20, 2.24**

Property 12: Bug Condition - Kind is invariant across reads

_For any_ note and any number of repeated reads, every reported `kind` (JSON `kind`, `x-kind`, admin note detail) SHALL be equal.

**Validates: Requirements 2.20, 2.24**

Property 13: Bug Condition - Kind survives non-content operations

_For any_ note and any operation in `{renew, changeTtl, readRaw, readJson, readHtml}`, `m:<name>.k` SHALL be byte-for-byte what it was before the operation, including remaining absent on legacy records.

**Validates: Requirements 2.22**

Property 14: Bug Condition - Kind is recomputed only on content rewrite

_For any_ edit that supplies new content, `m:<name>.k` SHALL equal `resolveKind(newContent)`, and a content rewrite SHALL be the only operation that changes it.

**Validates: Requirements 2.23**

Property 15: Bug Condition - Legacy records are unaffected

_For any_ note whose meta was written by the current code (no `k` field), the fixed code SHALL select the same read branch as the current code and SHALL report `kind = isUrl(content) ? "url" : "text"`.

**Validates: Requirements 2.21**

Property 16: Preservation - Everything outside the four bug conditions

_For any_ input where none of `isBugCondition_1..4` holds, the fixed code SHALL produce the same result as the current code, compared over HTTP status, JSON error `code`, all `x-*` metadata headers, `location` on 302, `/raw` bytes, and the resulting `n:<name>` / `m:<name>` KV state excluding the new `k` field.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15**

## Fix Implementation

### Changes Required

Assuming the root-cause analysis is correct.

#### D1 — token out of the URL, and out of the logs

**File**: `src/util.ts`

1. **Add `redactLogLine(s)`** — pure, exported, so it can be property-tested in isolation:
   ```
   const SECRET_QS_RE = /([?&](?:edit|token|key|ts)=)[^&\s]*/gi;
   FUNCTION redactLogLine(s)
     RETURN String(s).replace(SECRET_QS_RE, "$1[redacted]")
   END FUNCTION
   ```
   `edit` and `token` cover the deprecated edit transport; `key` covers `/admin/*?key=<ADMIN_KEY>`, which is the same class of secret-in-URL and is free to fix here; `ts` covers the challenge token added by D3. The replacement keeps the parameter name so the log line still shows *that* a token was presented — this also makes the redaction non-vacuously testable.

**File**: `src/index.ts`

2. **Wrap both loggers**: `baseApp.use("*", logger((m, ...r) => console.log(redactLogLine(m), ...r)))`, same for `subApp`. hono's `logger()` builds `path = url.slice(url.indexOf("/", 8))` — path *plus* query — and passes the whole line to the print function, so this single seam covers the incoming (`<--`) and outgoing (`-->`) lines for every route, including the deprecated GET form.
3. **Read the header transport in `handleEdit`** with strictly additive precedence:
   ```
   const token = bp.token
              || req.headers.get("x-edit-token")
              || url.searchParams.get("edit")
              || "";
   ```
   Body first, deliberately: every request shape that exists today resolves to exactly the same token it resolves to now, which makes Property 16 trivially true for legacy clients. (Rejected alternative: header-first. It is more idiomatic but changes the outcome for a request carrying *both* a body token and a different header token — an input outside every bug condition, so preservation would have to be argued rather than observed.)
4. **Do not change routing.** `handleSubdomain` already sends every POST/PUT to `handleEdit`, so `POST /` with `X-Edit-Token` reaches it with no new dispatch rule; `url.searchParams.has("edit")` stays as the deprecated GET entry point. A GET carrying only `X-Edit-Token` therefore falls through to the read path, exactly as it does today (2.3, and required by Property 16).
5. **Response side**: unchanged. `noteMetaHeaders` only emits `x-edit-token` when an `editToken` is passed, which happens on create only; the edit JSON response and `resultPage(..., editToken = null)` already omit it.

**File**: `src/views/EditNotePage.tsx`

6. **Rewrite `save()`** to POST out-of-URL, and fix the header comment (2.6):
   ```
   fetch("/", {
     method: "POST",
     headers: { "content-type": "application/json",
                accept: "application/json",
                "x-edit-token": token },
     body: JSON.stringify({ content: c })
   })
   ```
   Status handling (`ok` / `403` / `429` / other) and the Cmd/Ctrl-S binding are unchanged. The token still comes from `location.hash`, which is never sent to any server. The file's header comment currently describes the GET form and claims the token never reaches server logs; it is rewritten to describe the POST + header form, which makes the claim true.

#### D2 — thread `ExecutionContext` and keep telemetry alive

**File**: `src/util.ts`

1. **Add the `Background` facade** — `ctx.waitUntil` when the platform gave us one, a settle-before-return queue when it did not:
   ```
   FUNCTION makeBackground(exeCtx)
     pending := []
     hasCtx := exeCtx != NULL AND typeof exeCtx.waitUntil = "function"
     RETURN {
       waitUntil(p):
         q := Promise.resolve(p).catch(ignore)   // telemetry never rejects outward
         IF hasCtx THEN exeCtx.waitUntil(q) ELSE pending.push(q),
       settle():
         IF pending is empty THEN RETURN resolved
         RETURN Promise.all(pending.splice(0))
     }
   END FUNCTION
   ```
   The fallback exists because `c.executionCtx` is not guaranteed — hono's getter throws when the context was constructed without one, and unit-style tests can call handlers directly. In the fallback the response waits for the KV write; that costs a few milliseconds in tests and never happens in production, and it makes Property 4 deterministic in both modes.

**File**: `src/index.ts`

2. **`fetch(req, env, ctx)`** — annotate `ctx: ExecutionContext` and forward it: `baseApp.fetch(req, env, ctx)` / `subApp.fetch(req, env, ctx)`. Forwarding is what makes `c.executionCtx` usable at all.
3. **Add a guarded accessor and a single choke point**:
   ```
   function safeExecutionCtx(c) { try { return c.executionCtx } catch { return null } }

   async function withBackground(c, run) {
     const bg = makeBackground(safeExecutionCtx(c));
     try { return await run(bg) } finally { await bg.settle() }
   }
   ```
   `try/catch` is mandatory: the getter throws rather than returning `undefined`. `finally` guarantees settle even when a handler throws into `onError`.
4. **Wire the three write routes** through `withBackground`: `baseApp.on(["POST","PUT"], "/")`, the `baseApp.get("/")` branch that forwards to `handleCreate` when `?c=` is present, and `subApp.all("*")`.
5. **Thread `bg` into the handlers**: `handleCreate(req, env, url, bg)`, `handleEdit(req, env, sub, url, bg)`, `handleSubdomain(req, env, host, url, bg)` (which forwards it to `handleEdit`). Annotate the new parameter as `bg: Background` so `tsc --noEmit` reports every call site that forgets it — the only compiler-level safety net available under `strict: false`.
6. **Convert all 11 rejection sites** from `recordReject(env, code, ip)` to `bg.waitUntil(recordReject(env, code, ip))`: in `handleCreate` — `brand_blocked`, `bad_scheme` (dangerous scheme), `bad_scheme` (non-http protocol), `shortener_blocked`, `unsafe_target`, `content_blocked`; in `handleEdit` — the same five minus `brand_blocked`.
7. **Floating-promise audit result**: `recordReject` is the only unawaited promise on the write path. Every other KV write is inside an awaited `Promise.all` (`handleCreate` puts, `handleEdit` puts, `handleAbuseReport` puts), `rateLimit` awaits its own put, and `aiModerate` awaits its cache put. No other site changes. `recordReject`'s internal read-modify-write remains non-atomic — concurrent rejections from one IP can still lose an increment; that is a pre-existing KV limitation, out of scope, and called out in the test notes because it constrains how Property 4 may be exercised (sequential requests only).

#### D3 — abuse reporting hardening

**File**: `src/constants.ts`

1. Replace `ABUSE_AUTO_DISABLE = 3` with:
   ```
   ABUSE_AUTO_QUARANTINE   = 10          // distinct reporter groups
   QUARANTINE_MAX_TTL_SEC  = 7 * 86400   // == longest note TTL
   QUARANTINE_MIN_TTL_SEC  = 3600        // == shortest note TTL
   ABUSE_GROUP_TTL_SEC     = 30 * 86400  // == abuse:<name> counter TTL
   ```
   **Threshold rationale**: after group collapsing, one unit of the counter costs one distinct /64 or /24 *and* one solved challenge. 10 is high enough that a single residential delegation (typically a /56 or /48, i.e. 256–65536 /64s) no longer buys a takedown cheaply, and low enough that a genuinely abused link still trips within a day. `ABUSE_AUTO_DISABLE` is removed rather than aliased; its only importer is `src/index.ts`.

**File**: `src/util.ts`

2. **Add `reporterGroup(ip)`** — canonical, form-independent:
   ```
   FUNCTION reporterGroup(ip)
     t := lowercase(trim(ip))
     IF t is empty THEN RETURN "v0:unknown"
     IF t contains ":" THEN
       strip zone id (everything from "%")
       IF t ends with an embedded IPv4 THEN convert that tail to two hex groups
       expand "::" so the address has exactly 8 groups
       zero-pad each group to 4 hex digits
       RETURN "v6:" + join(first 4 groups, ":")      // /64
     ELSE
       RETURN "v4:" + join(first 3 octets, ".")      // /24
     END IF
   END FUNCTION
   ```
   This replaces the chained `split(":").slice(0,4)…split(".").slice(0,3)` truncation, which silently fails on compressed IPv6 — the exact reason one actor can present as three reporters (1.11).

**File**: `src/index.ts`, `handleAbuseReport`

3. **Verify the challenge before counting** (2.12, 2.13):
   ```
   const bodyRes = await readBody(req);
   const tsToken = req.headers.get("x-turnstile-token")
                || (bodyRes.ok && bodyRes.body.turnstile)
                || "";
   const v = await verifyTurnstile(env, tsToken, ip);
   if (!v.ok) return replyError(req, url, "challenge_failed",
                                "Human verification failed", 403,
                                { reason: v.reason });
   ```
   `verifyTurnstile` already returns `{ok:true}` when `TURNSTILE_SECRET` is unset and fails open on network errors, so the unconfigured deployment keeps working unchanged. The verification happens **before** any read or write of the counter, so an unverified report is fully inert.
4. **Key the dedupe on the reporter group, not the raw address, and align its lifetime with the counter**:
   ```
   const group    = reporterGroup(ip);
   const seenKey  = "abuse-dedupe:" + sub + ":" + (await sha256Base64Url(group)).slice(0, 12);
   ```
   The `:<day>:` segment is dropped and the TTL becomes `ABUSE_GROUP_TTL_SEC` (30 days), so one group counts at most once per note per counter lifetime — which is what Property 8 requires and what makes the threshold mean "10 distinct ranges". Same-day duplicates still answer `deduped: true` (3.12); the key prefix is unchanged, and stale day-scoped keys simply expire.
5. **Replace the hard disable with a bounded, reversible quarantine**:
   ```
   IF count >= ABUSE_AUTO_QUARANTINE THEN
     ttl := clamp(remainingNoteTtlSec(meta), QUARANTINE_MIN_TTL_SEC, QUARANTINE_MAX_TTL_SEC)
     put "d:" + sub = { reason: "community_reports", auto: true,
                        count, at: now, exp: now + ttl*1000 }
         with expirationTtl = ttl
   END IF
   ```
   `remainingNoteTtlSec` is derived from `m:<sub>` (`ct` + `TTL_OPTIONS[t]` − now); when meta is missing or unparseable it falls back to `QUARANTINE_MAX_TTL_SEC`. The key stays `d:<sub>`, so the 410 read path (3.11) and `/admin/enable`'s `delete("d:"+name)` + `delete("abuse:"+name)` (3.13) keep working with no change. `exp` is stored **inside the payload** because KV does not expose a record's remaining TTL on read — it is what makes the bound observable to the 410 page, to the admin detail view, and to Property 10's test.
6. **Owner recourse** (2.16): the 410 status page gains, for `auto: true` markers only, the auto-expiry timestamp and an appeal line naming `ABUSE_EMAIL`; the JSON 410 gains `details.auto` and `details.until` for auto markers. Status (`410`) and error `code` (`disabled`) are unchanged for both auto and admin markers. **No self-serve un-quarantine endpoint**: the edit token is held by the note's author, and for a genuinely malicious note the author is the abuser, so token-gated self-clearing would defeat the mechanism. The documented path is expiry-plus-appeal.

**File**: `src/views/InterstitialPage.tsx`

7. **Optional challenge widget**: signature becomes `interstitialPage(sub, target, siteKey?)`. When `siteKey` is present, render `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>` plus `<div class="cf-turnstile" data-sitekey={siteKey} data-action="abuse-report">` inside the warn card. The existing CSP already allows `challenges.cloudflare.com` in `script-src`, `frame-src`, and `connect-src`, so **no CSP change** (2.18). `REPORT_JS` stays inline (moving page JS to `ASSETS` is out of scope, so `'unsafe-inline'` in `script-src` remains) and is extended to read the widget's hidden `cf-turnstile-response` input when present and POST `{"turnstile": <token>}` as JSON. `handleSubdomain` passes `env.TURNSTILE_SITEKEY`; the parameter is optional so `test/views.test.ts` compiles unchanged.

**File**: `src/responses.ts`

8. `readBody` gains one field so the challenge token survives body parsing: `turnstile: j.ts ?? j.turnstile ?? j["cf-turnstile-response"]` for JSON, and `g("cf-turnstile-response") || g("ts") || g("turnstile")` for form bodies. Existing fields and their precedence are untouched.

**File**: `wrangler.toml`

9. Add `[vars] TURNSTILE_SITEKEY = ""` (public, safe in the repo). `TURNSTILE_SECRET` stays a secret (`wrangler secret put`). Regenerate `worker-configuration.d.ts` with `npm run types`. Note that `env.TURNSTILE_SECRET` type-checks today only because handler `env` parameters are implicitly `any`.

#### D4 — persist the note kind

**File**: `src/util.ts`

1. **Two helpers, one derivation each**:
   ```
   FUNCTION resolveKind(content)          // write-time authority
     RETURN isUrl(content) ? "url" : "text"
   END FUNCTION

   FUNCTION readKind(meta, content)       // read-time authority + legacy fallback
     IF meta != NULL AND (meta.k = "url" OR meta.k = "text") THEN RETURN meta.k
     RETURN resolveKind(content)          // pre-fix records: 2.21
   END FUNCTION
   ```
   Guarding on the exact two literals means a corrupt or unknown `k` degrades to today's behavior instead of producing an undefined branch.

**File**: `src/index.ts`

2. **`handleCreate`** — `const kind = resolveKind(rawContent); const urlMode = kind === "url";` and persist it: `meta = JSON.stringify({ v: 1, h: tokenHash, t: ttlKey, ct: createdAtMs, k: kind })`. **`v` stays `1`**: nothing in the codebase reads `meta.v`, and the actual feature detection required by 2.21 is *presence of `k`*, so a bump would add a version predicate with no reader. If a future change needs real versioning, that is the moment to bump.
3. **`handleEdit`** — parse the original meta once (it is currently re-parsed inline for the `ct` comparison), then:
   - content supplied → `kind = resolveKind(content)`; `meta.k = kind` (2.23).
   - no content supplied → `kind = readKind(meta, existingContent)`; `meta.k` is **left exactly as it was**, including absent (2.22).
   - meta rewrite guard becomes `ttlKey !== origMeta.t || meta.ct !== origMeta.ct || meta.k !== origMeta.k`, so newly-persisted `k` is not dropped by the "nothing changed, reuse the original bytes" path.
   - `urlMode`, `target`, JSON `kind`, and `x-kind` all derive from that single `kind` value (2.24).

   **Rejected alternative**: backfilling `k` on TTL-only/renew edits. The value would be identical to the legacy fallback, so it is observationally safe and would shorten the migration window — but it makes `meta.k` change during an operation that supplies no content, which contradicts 2.22/2.23 as written and would falsify Property 13 for legacy records. The 7-day maximum TTL already bounds the window, so the literal reading wins.
4. **`handleSubdomain`** — `const kind = readKind(meta, content); const urlMode = kind === "url";` replaces `const urlMode = isUrl(content)`. The `parseUrlSafe(content)` guard that degrades an unparseable "url" note to `notePage` stays: kind selects the branch, and the parse check remains a safety net (and preserves today's behavior for that edge). `isAllowedTarget(target)` → 302 vs interstitial is untouched (3.1, 3.2).

**File**: `src/admin.ts`

5. `loadNoteDetail` — `kind: content != null ? readKind(meta, content) : null`. `meta` is already parsed there; only the derivation changes (1.17, 2.24).

**File**: `src/views/ResultPage.tsx`

6. Accept the kind instead of guessing: `resultPage(name, content, mode, ttlKey, editToken, kind?)` and, inside `Result`, `const link = (kind ?? resolveKind(content)) === "url"`. Both production call sites already hold `kind` and pass it. The parameter is optional and trailing, so `test/views.test.ts`'s three `resultPage(...)` calls compile unchanged **and** their snapshots stay byte-identical — the churn is confined to the two pages that actually change (see *Snapshot Review*).
7. `isAllowedTarget(content)` for the whitelist warning is unchanged; only the `url`-vs-`text` decision moves to the passed kind.

### Documentation Consistency (2.5)

| File | Change |
|------|--------|
| `docs/API.md` | Route table row `POST <sub>.0g.hk/?edit=tk` → document `POST <sub>.0g.hk/` with `X-Edit-Token` (or body `token`) as preferred, and mark `?edit=` **deprecated but supported**. Update the "编辑 / 续期" curl examples (currently four `?edit=$TOKEN` URLs) to the header form, keeping one deprecated example labelled as such. Update the "浏览器兼容" list entry `GET <sub>.0g.hk/?edit=tk&c=new` to note it still works and is redacted from logs. Add the abuse/quarantine section: new threshold, group collapsing, bounded marker, appeal path. |
| `public/llms.txt` | The edit example already uses the body form (`-d '{"content":…,"token":…}'`) and stays valid; add one line naming `X-Edit-Token` as the header alternative. Update the abuse/rate lines if they cite the old threshold. |
| `public/llms-full.txt` | Same header alternative in the edit sections; fix `Report abuse … After ABUSE_AUTO_DISABLE (3) reports the note …` (line 98) to describe the group-based threshold, the challenge, and the bounded reversible quarantine. |

Two pre-existing doc drifts are noted but **not** fixed here (out of scope): `llms-full.txt` says `401 invalid_token` where the code returns `403`, and `editUrl` is shown without the `#t=` fragment.

### Backward Compatibility with Live KV Data

- **`m:<name>` without `k`** — every record written by F. `readKind` falls back to `isUrl(content)`, which is precisely today's derivation, so those notes behave identically (2.21, Property 15). They are never rewritten by a read, and a TTL-only edit leaves `k` absent by design. Because the longest TTL is 7 days, every legacy record is gone at most 7 days after deploy, at which point the fallback is dead code that can be removed in a follow-up.
- **`d:<name>` written by F** — 365-day markers created before the fix keep their TTL and their `{reason, at}` payload (no `auto`, no `exp`). The read path treats a marker without `auto` as an admin-style disable and renders the existing 410 text, so nothing regresses; `/admin/enable` clears them as before. Clearing pre-existing long markers is an operational task, not a code path.
- **`abuse-dedupe:<sub>:<day>:<hash>`** — orphaned by the key-shape change; they expire within 24 hours and their only effect while alive is that a group already deduped today may count once more. Bounded and harmless.
- **`abuse:<name>` counters** — carried over unchanged, now compared against the higher threshold, which can only make the auto-action *less* likely.
- **`rej:*` / `rl:*` / `cfg:v1`** — untouched.

### Implementation Sequencing

1. **D2 first.** It touches only `fetch`, the three route closures, the handler signatures, and the 11 `recordReject` calls; it changes no HTML, so no snapshot moves. Landing it first also gives the later fixes a working `bg` to use if they need one, and puts the new type annotations in place early.
2. **D4 second.** Independent of D1/D3, confined to `util.ts` + four call sites + one optional `resultPage` parameter, and covered by the existing `go=1` and allowlist-302 tests as load-bearing preservation checks.
3. **D1 and D3 last, together.** Both edit inline view JS and both move snapshots (`EditNotePage` for D1, `InterstitialPage` for D3), so pairing them means one intentional snapshot review instead of two. They do not otherwise overlap: D1 touches `handleEdit` + `logger`, D3 touches `handleAbuseReport` + constants.
4. **Docs last**, once the accepted transports and the final threshold are fixed.

## Testing Strategy

### Validation Approach

Two phases. First surface counterexamples on the **unfixed** code to confirm or refute each root cause — the same tests then become the fix checks. Second, verify preservation for everything outside the four bug conditions, leaning on the existing 27-test baseline plus new property-based tests.

`fast-check` is **not** currently a dependency. Add it (`npm i -D fast-check`) — it earns its place on the properties whose input domain is genuinely large (token/content shapes, address text forms, and the `URL_NO_SCHEME_RE` boundary), and is deliberately *not* used for the properties that need ordered multi-request sequences against shared KV counters, where a generator would be slow and would fight the non-atomic increment in `recordReject`.

Two harness requirements apply throughout:

- **Log capture** (Property 1). `logger()` prints through `console.log`. Capture with `vi.spyOn(console, "log")` (also `error`/`warn`/`info` so a stray `console.error` cannot leak) around a `SELF.fetch`, join every captured argument, and assert the token substring is absent. The assertion must be **non-vacuous**: for the deprecated `?edit=` request, also assert some captured line contains `edit=[redacted]`, which proves a line was emitted *and* redacted rather than never produced. Complement this with a direct unit/property test of the pure `redactLogLine` over generated tokens, which is where the real coverage lives.
- **Distinct `cf-connecting-ip` per request** (Properties 4, 5, and any test that trips a gate). `rateLimit()` falls back to `ip = "0"` when the header is absent, so header-less requests share one `rl:0:<minute>` bucket and one `rej-ip:0` counter and would cross-contaminate every rejection-count and adaptive-cap assertion. Each test sequence must mint its own address (e.g. `198.51.100.<n>` from a per-test counter) and send it on every request in the sequence. The `"0"` fallback itself is a known separate issue and is out of scope.

### Exploratory Bug Condition Checking

**Goal**: surface counterexamples that demonstrate each defect BEFORE implementing the fix, confirming or refuting the root-cause analysis. If refuted, re-hypothesize before writing any fix.

**Test Plan**: write the tests below against the current `src/`, run `npx vitest run`, and record the failures.

**Test Cases**:
1. **Token in log line (D1)** — spy on `console.log`, `SELF.fetch("https://<sub>.0g.hk/?edit=<token>&c=x")`, assert no captured line contains the token (will fail on unfixed code; the captured line is `<-- GET /?edit=<token>&c=x`).
2. **Header transport ignored (D1)** — `POST /` with `X-Edit-Token` and body `{"content":"x"}`, expect 200 (will fail on unfixed code: 400 `missing_token`).
3. **Rejection counters (D2)** — one create with `content: "javascript:alert(1)"` from a dedicated IP, then read `rej:<day>:bad_scheme` and `rej-ip:<ip>` from `env.NOTES` (may fail on unfixed code — the whole point of the defect is that it is timing-dependent; if `SELF.fetch` happens to await the floating promise, this passes even unfixed, so treat a pass as inconclusive and rely on test 4).
4. **Adaptive cap (D2)** — five rejected creates then three valid creates from one IP; assert at most 2 of the three are non-429 (will fail on unfixed code).
5. **One /64 disables a note (D3)** — three reports from `2001:db8::1/::2/::3`, assert `d:<name>` absent and status ≠ 410 (will fail on unfixed code: all three count, note is disabled for 365 days).
6. **Unverified report counted (D3)** — with `TURNSTILE_SECRET` set in the test env and no challenge token, assert status ≥ 400 and the counter unchanged (will fail on unfixed code: 200, counter incremented).
7. **Kind not persisted (D4)** — create a note, read `m:<name>` from `env.NOTES`, assert a `k` field exists (will fail on unfixed code).
8. **Edge case — kind flip (D4)** — create text `hello world`, edit content to `docs.example.com`, read with `redirect: "manual"`; observe the note become a redirect with no owner signal (documents 1.16; after the fix the flip is still allowed but is now recorded in `k` and only happens on an explicit content rewrite).

**Expected Counterexamples**:
- A log line containing the raw edit token, for both the GET and the documented `POST ?edit=` form.
- `400 missing_token` for a header-only edit.
- `rej-ip:<ip>` below the number of rejections, and the 6th–8th request from a rejected IP still accepted.
- `abuse:<name>` = 3 and `d:<name>` present after three addresses inside one /64.
- `m:<name>` = `{"v":1,"h":…,"t":"7d","ct":…}` with no `k`.
- Possible causes to confirm: token read only from body/query; `fetch(req, env)` has no `ctx`; compressed-IPv6 truncation failing; kind re-derived at read time.

### Fix Checking

**Goal**: verify that for all inputs where a bug condition holds, the fixed code produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition_1(input) DO
  response := handleEdit_fixed(input)
  logs     := capturedLogLines(input)
  ASSERT FOR ALL line IN logs:            NOT containsToken(line, input.token)
  ASSERT FOR ALL h IN response.headers:   NOT containsToken(h, input.token)
  ASSERT NOT containsToken(response.body, input.token)
END FOR

FOR ALL input WHERE isBugCondition_2(input) DO
  n := COUNT(r IN input WHERE isRejectedByGate(r))
  runAll_fixed(input)
  ASSERT SUM(kv["rej:" + today + ":" + code] FOR code IN REJECT_CODES) = n
  ASSERT kv["rej-ip:" + input.ip] = n
END FOR

FOR ALL input WHERE isBugCondition_3(input) DO
  runAll_fixed(input)
  ASSERT kv["abuse:" + name] = COUNT(distinctVerifiedReporterGroups(input))
  ASSERT (kv["d:" + name] = NULL) OR (markerTtlSeconds <= QUARANTINE_MAX_TTL_SEC)
END FOR

FOR ALL input WHERE isBugCondition_4(input) DO
  created := handleCreate_fixed(input)
  ASSERT meta(input).k IN {"url", "text"}
  ASSERT meta(input).k = created.json.kind = created.headers["x-kind"]
  ASSERT readBranch_fixed(input) = branchFor(meta(input).k)
END FOR
```

**Property → test mapping** (15 fix-checking properties; PBT = property-based with `fast-check`, EX = example-based):

| Property | Approach | Concrete test |
|----------|----------|---------------|
| 1 — Token confidentiality | **PBT** + EX | PBT: `redactLogLine` over generated tokens embedded in generated query strings — for all tokens, output contains `[redacted]` and not the token, and non-secret parameters are untouched. EX: console-spy integration test per transport (header POST, body POST, deprecated GET), asserting absence of the token in logs/headers/body and presence of `edit=[redacted]` for the GET. |
| 2 — Transport equivalence | **PBT** | Generate `(content, ttl ∈ {1h,1d,7d,∅}, renew?)`; for each, create three notes and edit one via header, one via body, one via query; assert equal status and equal `/raw` bytes across the three. Generator must keep content within `urlMax`/`textMax` to stay off the 413 path. Also assert `GET` + `X-Edit-Token` performs a plain read (no mutation). |
| 3 — No forged token | **PBT** | Generate a real token and a mutation (bit flip, truncation, extension, empty, wrong-length base64url); assert status ∈ {400, 403} on all three transports and `/raw` unchanged. Empty ⇒ 400 `missing_token`, non-empty ⇒ 403 `invalid_token`. |
| 4 — Rejection accounting exact | EX (parametrized) | Sequences of 1, 3, and 5 rejections mixing `bad_scheme` / `shortener_blocked` / `brand_blocked`, one fresh IP per sequence, requests issued **sequentially** (non-atomic KV increment forbids concurrency); read counters via `env.NOTES.get`. |
| 5 — Adaptive cap engages | EX | 5 rejections then 4 valid creates from one fresh IP inside one minute; assert ≤ 2 non-429 and that the 429s carry `details.limit` and `details.windowSeconds: 60`. |
| 6 — Telemetry never blocks or breaks | EX | For each of the five gate codes, assert status and JSON `code` equal the pre-fix baseline values (table-driven, so the assertion is on absolute expected values, not on a live comparison with F). |
| 7 — Sub-threshold never disables | EX (parametrized) | For `n ∈ {1, 5, 9}`, submit `n` reports from `n` distinct /64s; assert `d:<name>` absent, subdomain status ≠ 410, `abuse:<name>` = n. |
| 8 — One address range counts once | **PBT** + EX | PBT on the pure `reporterGroup`: for all pairs of addresses in one /64 (or /24) generated in mixed text forms — compressed, expanded, IPv4-mapped, with zone id — the group strings are equal, and for addresses in different /64s they differ. EX: 4 reports from `2001:db8::1`, `2001:db8:0:0::2`, `2001:0db8:0000:0000:0000:0000:0000:0003`, `2001:db8::4` ⇒ `abuse:<name>` ≤ 1, `deduped: true` on reports 2–4, `d:<name>` absent. |
| 9 — Unverified reports inert | EX | Two env shapes. `TURNSTILE_SECRET` unset ⇒ report accepted, counter increments (2.13). Secret set + missing/invalid token ⇒ status ≥ 400, counter and `d:` unchanged. Cover the `verifyTurnstile` fail-open-on-network-error branch explicitly so it is a known, deliberate behavior. Plus an integration check that the interstitial page's report control still round-trips (2.18). |
| 10 — Auto action reversible and bounded | EX | Drive `abuse:<name>` to the threshold from 10 distinct /64s; assert `d:<name>` exists with `auto: true` and payload `exp − at ≤ QUARANTINE_MAX_TTL_SEC * 1000` (the payload `exp` is the observable bound — KV does not expose remaining TTL on read); assert 410 + JSON code `disabled`; then `/admin/enable` and assert `d:` and `abuse:` are gone and status ≠ 410. |
| 11 — Kind persisted and authoritative | EX + **PBT** | EX: one URL note (allowlisted target ⇒ 302 with matching `location`), one URL note (non-allowlisted ⇒ interstitial), one text note (⇒ `notePage`); each asserts `m:<name>.k` = JSON `kind` = `x-kind` = the observed branch. PBT: generated content strings straddling the `URL_NO_SCHEME_RE` boundary (bare hostnames, hostnames with ports/paths, strings with whitespace, punycode-ish, trailing dots) ⇒ persisted `k` always equals the branch actually taken. |
| 12 — Kind invariant across reads | **PBT** | For generated content, read the note 5 times across `/`, `/raw`, `?format=json`, and `/admin/note`; assert all reported kinds are equal. |
| 13 — Kind survives non-content ops | EX | For a URL note and a text note (and one hand-seeded legacy record with no `k`), apply `renew=1`, `ttl=1d`, `/raw`, JSON read, HTML read; after each, assert the raw `m:<name>` `k` field is unchanged — still the same literal, or still absent for the legacy record. |
| 14 — Kind recomputed on rewrite | EX + **PBT** | PBT: generate `(kind0Content, kind1Content)` pairs, create then edit content, assert `m:<name>.k = resolveKind(newContent)` and that the read branch follows. EX: the text → `docs.example.com` flip from exploratory test 8, now asserting the flip is recorded in `k`. |
| 15 — Legacy records unaffected | EX | Seed `n:` + `m:` directly via `env.NOTES.put` with `{"v":1,"h":…,"t":"7d","ct":…}` (no `k`) for three contents: allowlisted URL, non-allowlisted URL, plain text. Assert branch and reported `kind` match the pre-fix expectations (302 / interstitial / render, and `kind = isUrl(content)`). This is the only test that must construct KV state by hand rather than through the API. |

### Preservation Checking

**Goal**: verify that for all inputs where no bug condition holds, the fixed code produces the same result as the original.

**Pseudocode:**
```
FOR ALL input WHERE NOT (isBugCondition_1(input) OR isBugCondition_2(input)
                      OR isBugCondition_3(input) OR isBugCondition_4(input)) DO
  ASSERT F(input) = F'(input)
END FOR
// equality over: status, JSON error code, all x-* headers, location on 302,
// /raw bytes, and KV state for n:<name> and m:<name> minus the new `k`.
```

**Testing Approach**: property-based testing is recommended here because the preserved surface is wide (read paths, body-token edits, gate errors, admin), it generates many inputs across that domain automatically, it catches edge cases hand-written tests miss — notably around `URL_NO_SCHEME_RE` — and it gives a strong guarantee that non-buggy inputs are untouched. Because F and F' cannot both be loaded in one Worker isolate, equality is captured as **recorded expectations**: run the generated corpus against the current code first, snapshot the observable tuple `(status, error code, x-* headers, location, /raw bytes, meta minus k)` to a fixture, then assert F' reproduces that fixture.

**Test Plan**: build the corpus and record it on the unfixed code before any source change, then re-run it after each of the four fixes lands.

**Test Cases**:
1. **Read-path preservation** — observe 302-on-allowlist, interstitial (including `?go=1` not bypassing), `notePage`, `/raw` bytes + `content-type`, JSON read shape, 404, and 410 on the unfixed code; assert unchanged after the fix. The existing `go=1` and allowlist-302 tests in `test/api.test.ts` are the load-bearing checks here and **must pass unmodified**.
2. **Body-token edit preservation** — observe every `content` / `ttl` / `renew` combination from `docs/API.md` plus the expiry-window reset on the unfixed code; assert unchanged. Extend with a body-token *and* header-token request to pin the documented body-first precedence.
3. **Error-envelope preservation** — observe `missing_token`, `invalid_token`, `not_editable`, `corrupt_meta`, `invalid_ttl`, `invalid_name`, `reserved_name`, `name_taken`, `url_too_long`, `text_too_long`, `malformed_url`, `rate_limited`, and every gate code on the unfixed code; assert identical codes and statuses.
4. **Create-response preservation** — observe the full 201 JSON field set and all `x-*` headers, and that `editToken` appears exactly once, on the unfixed code; assert unchanged apart from `m:<name>` gaining `k`.
5. **Admin preservation** — observe `/admin/stats`, `/admin/note`, `/admin/disable`, `/admin/enable`, `/admin/delete`, `/admin/config` with a valid `ADMIN_KEY`, plus the session login flow, on the unfixed code; assert unchanged, and that `/admin/enable` still clears both `d:` and `abuse:`. Note the `?key=` redaction only changes log output, never the response.
6. **CORS / assets preservation** — `OPTIONS` on several paths still returns the same 204 with the same headers; `env.ASSETS` still serves `/llms.txt` and `/robots.txt`; `curl 0g.hk` (non-browser `accept`) still returns the plain-text manual.

### Snapshot Review (intentional churn)

`test/views.test.ts` snapshots in `test/__snapshots__/views.test.ts.snap` will fail for two cases. The updates are **intentional and must be reviewed line by line, not regenerated blindly** (`npx vitest run -u` only after reading the diff):

- **`editNotePage`** — reviewer must verify: `save()` uses `method:"POST"`; the token appears **only** as the value of the `x-edit-token` request header inside the script and **never** inside any URL string (no `"/?edit="`, no `encodeURIComponent(token)` in a URL position); the content moves to a JSON body; the `#t=` fragment parse, the `/raw` seeding fetch, the 403/429 status messages, and the Cmd/Ctrl-S binding are all unchanged; the header comment no longer describes the GET form.
- **`interstitialPage`** — reviewer must verify: with no `siteKey` (the shape the snapshot test exercises) the only diff is the extended `REPORT_JS`, which reads `cf-turnstile-response` defensively and still POSTs to `/abuse/report`; the confirm dialog, the target/host display, and `rel="noopener noreferrer nofollow"` on the continue link are unchanged. Add a second snapshot case **with** a `siteKey` to pin the widget markup: the `challenges.cloudflare.com/turnstile/v0/api.js` script tag and the `cf-turnstile` div with the right `data-sitekey`, both of which are already permitted by the existing CSP.

The three `resultPage` snapshots must **not** move: the new `kind` parameter is optional and trailing, and the test's existing calls omit it, so the rendered HTML is byte-identical. A `resultPage` snapshot diff is a signal that something unintended changed.

### Unit Tests

- `redactLogLine` — `edit`, `token`, `key`, `ts` parameters redacted in any position; parameter name preserved; non-secret parameters (`c`, `n`, `ttl`, `format`) untouched; idempotent; safe on empty and on non-string input.
- `reporterGroup` — compressed, expanded, IPv4-mapped, zone-id, IPv4, empty, and malformed inputs; /64 and /24 boundaries; stability across text forms.
- `resolveKind` / `readKind` — `k` present and valid, present but corrupt (`k: "URL"`, `k: 1`, `k: null`), and absent; the fallback must equal `isUrl(content)` exactly.
- `makeBackground` — with a real `ExecutionContext` (`waitUntil` receives the promise, `settle()` resolves immediately); with `null` (`settle()` awaits queued promises); a rejecting promise never propagates out of either path.
- Quarantine TTL clamp — `remainingNoteTtlSec` for `1h`/`1d`/`7d` notes at several ages, for missing meta, and for corrupt meta; result always within `[QUARANTINE_MIN_TTL_SEC, QUARANTINE_MAX_TTL_SEC]`.

### Property-Based Tests

- Token redaction over generated tokens and query strings (Property 1).
- Transport equivalence over generated `(content, ttl, renew)` (Property 2).
- Forged-token rejection over generated token mutations (Property 3).
- `reporterGroup` equality within a range and inequality across ranges, over generated address text forms (Property 8).
- Persisted kind vs. the branch actually taken, over content generated to straddle `URL_NO_SCHEME_RE` (Properties 11, 12, 14).
- Preservation of the recorded observable tuple over the generated request corpus (Property 16).

### Integration Tests

- Full editor round-trip: create → open `/edit#t=<token>` → seed from `/raw` → POST save with the header transport → re-read `/raw` and see the new content, with `console.log` captured throughout and asserted token-free.
- Deprecated-transport round-trip: `GET /?edit=<token>&c=…` and `POST /?edit=<token>` both still mutate and return the same status and body as before, and both produce only redacted log lines.
- Abuse flow end-to-end: interstitial page → report control → below threshold (readable) → at threshold (410 with `auto: true`, bounded `exp`, appeal text) → `/admin/enable` → readable again.
- Rejection telemetry end-to-end: gate-tripping creates from one fresh IP → `/admin/stats` (Bearer `ADMIN_KEY`) reports counts equal to the rejections that actually occurred (2.11) → the adaptive cap engages on the same IP.
- Kind end-to-end across contexts: the same note reported identically by the subdomain read, `?format=json`, `x-kind`, `/admin/note`, and the result page after create and after edit.
