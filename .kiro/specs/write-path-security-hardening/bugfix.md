# Bugfix Requirements Document

## Introduction

Four related defects sit on the note create/edit write path of the 0g.hk Worker. They are grouped into one bugfix because they share the same request lifecycle (`fetch` → `handleSubdomain` → `handleCreate` / `handleEdit` / `handleAbuseReport`) and the same storage layout (`n:<name>` content, `m:<name>` meta, `d:<name>` disabled marker, `rej:*` telemetry).

| # | Defect | Impact |
|---|--------|--------|
| 1 | Edit token travels in the query string of a state-mutating GET | Owner credential is written into hono `logger()` output and Cloudflare request logs; mutation happens on a cacheable/prefetchable GET |
| 2 | `recordReject()` is called without `await` / `ctx.waitUntil` | Interception stats under-report and the adaptive rate limit (5 rejections → 2 req/min) rarely engages |
| 3 | `/abuse/report` is unauthenticated with `ABUSE_AUTO_DISABLE = 3` | Three addresses from one IPv6 /64 can hard-disable any note for 365 days, with email as the only recourse; the implemented `verifyTurnstile()` has zero call sites |
| 4 | Note kind (`url` vs `text`) is never persisted | A security-relevant branch (302 redirect vs interstitial vs render) is decided by a fuzzy regex re-evaluated on every read, so a note's kind can flip |

Out of scope: the broader refactoring, test-coverage, and documentation findings from the review, and the `cf-connecting-ip` fallback-to-`"0"` rate-limit bucket issue (referenced below only because it affects how defect 2 must be tested).

### How editing still works once the token leaves the query string

The token is not being removed from the user's hands — only from the *URL of the request*. All three existing entry points keep working:

- **Editor UI** — the edit link stays `https://<name>.0g.hk/edit#t=<token>`. The fragment is never sent to any server, which is already the design intent stated in `EditNotePage.tsx`. Only the page's internal save call changes: instead of `GET /?edit=<token>&c=<content>`, the page sends the token in a request header (or POST body) with the content in the body. The user-visible flow — open edit link, type, save — is byte-for-byte identical.
- **Documented API** — `public/llms.txt` and `public/llms-full.txt` already document the body form (`-d '{"content":"…","token":"<editToken>"}'`), which is unaffected.
- **`?edit=<token>` query form** — documented in `docs/API.md`, so it must keep working for back-compat. It becomes a deprecated transport: still accepted, but the token is redacted from logs, and (see 2.2) the deprecated form is the only path that may still mutate on GET.

## Bug Analysis

### Current Behavior (Defect)

**Defect 1 — edit token leaks into logs; mutation on GET**

1.1 WHEN the note editor page's `save()` runs THEN the system issues `GET /?edit=<token>&c=<content>`, placing the owner's edit token in the request URL.

1.2 WHEN any request to `<sub>.0g.hk` carries `?edit=<token>` THEN the system logs the full unredacted request path through `subApp.use("*", logger())`, and Cloudflare request logs record the same URL, so the token is readable by anyone with log access.

1.3 WHEN `?edit=<token>` is present on a GET request THEN the system mutates stored content and meta in response to a GET, making a non-idempotent write cacheable, prefetchable, and replayable from browser history.

1.4 WHEN the token is supplied in a request header THEN the system ignores it, because `handleEdit` reads the token only from the JSON/form body or `url.searchParams.get("edit")`.

**Defect 2 — rejection telemetry writes are dropped**

1.5 WHEN a create or edit request is rejected by a gate (`brand_blocked`, `bad_scheme`, `shortener_blocked`, `unsafe_target`, `content_blocked`) THEN the system calls `recordReject(env, code, ip)` without `await` and without `ctx.waitUntil`, so the KV writes to `rej:<day>:<code>` and `rej-ip:<ip>` may be cancelled when the Worker is reclaimed after the response.

1.6 WHEN the exported `fetch` handler runs THEN the system has no access to `ExecutionContext`, because its signature is `fetch(req, env)` and `ctx` is neither accepted nor threaded to the handlers, so no background write can be kept alive.

1.7 WHEN the `/admin/dashboard` 7-day interception chart is rendered THEN the system reports fewer rejections than actually occurred, because the per-code counters were lost.

1.8 WHEN a single IP accumulates rejections THEN the system usually fails to reach `ADAPTIVE_REJECT_THRESHOLD` (5) in `rej-ip:<ip>`, so the adaptive tightening to `ADAPTIVE_RATE_LIMIT` (2/min) rarely engages and an abusive client keeps the full 10/min budget.

**Defect 3 — abuse reporting can take down arbitrary links**

1.9 WHEN `POST /abuse/report` is received THEN the system accepts it with no authentication, no human-verification challenge, and no CSRF check.

1.10 WHEN reports for one name arrive from 3 distinct source addresses in a single day THEN the system reaches `ABUSE_AUTO_DISABLE` (3) and writes `d:<sub>` with `expirationTtl: 365 * 86400`, permanently disabling a legitimate note.

1.11 WHEN the reporter varies the low-order bits of its address THEN the system treats each variant as a distinct reporter, because the dedupe key hashes only the first 4 IPv6 groups / first 3 IPv4 octets — so all 3 reports can originate from one IPv6 /64 held by a single actor.

1.12 WHEN `TURNSTILE_SECRET` is configured THEN the system still performs no challenge verification on the report path, because `verifyTurnstile()` in `src/moderation.ts` has zero call sites anywhere in the codebase.

1.13 WHEN a note is auto-disabled by community reports THEN the system offers the owner no self-serve appeal or expiry — the marker outlives the note's own TTL (max 7 days) by up to a year, and the only recourse is emailing `abuse@0g.hk`.

**Defect 4 — note kind is not persisted**

1.14 WHEN a note is read on `<sub>.0g.hk` THEN the system re-derives `urlMode = isUrl(content)` at read time and uses that result to choose between a 302 redirect, the interstitial page, and the rendered note page.

1.15 WHEN stored text happens to match the scheme-less hostname heuristic `URL_NO_SCHEME_RE` THEN the system classifies that text note as a URL and serves it as a redirect target, so a fuzzy regex is the sole judge of a security-relevant branch.

1.16 WHEN a note's content is edited THEN the system may silently change the note's kind, so a text note can become a redirect (or a redirect become a text note) without the owner or any reader being told.

1.17 WHEN the same note is inspected from different code paths THEN the system may disagree with itself, because the kind derivation is duplicated in `handleCreate`, `handleEdit`, `handleSubdomain`, `admin.ts` `loadNoteDetail`, and `ResultPage.tsx`.

1.18 WHEN the `m:<name>` meta record is written THEN the system stores `{v, h, t, ct}` only — there is no `k` field, so nothing recorded at write time can be trusted at read time.

### Expected Behavior (Correct)

**Defect 1 — token never appears in a URL or a log line**

2.1 WHEN the note editor page saves THEN the system SHALL transmit the edit token out-of-URL (request header such as `X-Edit-Token`, or request body) and SHALL NOT place the token in the query string.

2.2 WHEN a request carrying an edit token in any transport is logged THEN the system SHALL redact the token from the logged line, so no log line contains a value that would authenticate as the note's edit token.

2.3 WHEN content is mutated THEN the system SHALL require a non-GET method (POST or PUT) for the non-deprecated transports; the deprecated `?edit=` GET form MAY continue to mutate solely for browser back-compat and SHALL be redacted in logs like every other transport.

2.4 WHEN an edit token is presented via header, body, or the deprecated `?edit=` query parameter THEN the system SHALL accept all three, SHALL apply identical validation (`sha256Base64Url` + `ctEq` against `meta.h`), and SHALL return identical success and error responses regardless of transport.

2.5 WHEN the token transport changes THEN the system SHALL keep `docs/API.md`, `public/llms.txt`, and `public/llms-full.txt` consistent with the implementation, documenting the preferred transport and marking `?edit=` as deprecated-but-supported.

2.6 WHEN `EditNotePage.tsx`'s header comment claims the token never reaches server logs THEN the system SHALL make that claim true.

**Defect 2 — every rejection is recorded exactly once**

2.7 WHEN the Worker handles a request THEN the system SHALL accept `ctx: ExecutionContext` in `fetch` and SHALL thread it to `handleCreate`, `handleEdit`, and any other handler that records telemetry.

2.8 WHEN a create or edit request is rejected by a gate THEN the system SHALL keep the `recordReject` write alive to completion via `ctx.waitUntil(...)` (or `await`), so the response is not blocked and the write is not cancelled.

2.9 WHEN N requests from one IP are rejected THEN the system SHALL leave `rej:<day>:<code>` counters whose sum equals N, and `rej-ip:<ip>` equal to N (within the 15-minute per-IP window).

2.10 WHEN an IP reaches `ADAPTIVE_REJECT_THRESHOLD` (5) rejections inside the per-IP window THEN the system SHALL apply `ADAPTIVE_RATE_LIMIT` (2 per minute) to that IP's subsequent create/edit requests.

2.11 WHEN the admin dashboard renders the 7-day interception chart THEN the system SHALL show counts that match the rejections that actually occurred.

**Defect 3 — reporting cannot be weaponised**

2.12 WHEN `POST /abuse/report` is received and `TURNSTILE_SECRET` is configured THEN the system SHALL verify the Turnstile token via `verifyTurnstile()` before counting the report, and SHALL reject an unverified report without incrementing any counter.

2.13 WHEN `TURNSTILE_SECRET` is not configured THEN the system SHALL continue to accept reports (challenge no-ops), so local development and the current deployment do not break.

2.14 WHEN reports accumulate below the auto-action threshold THEN the system SHALL keep the note fully readable — no `d:<sub>` marker, no 410.

2.15 WHEN the auto-action threshold is reached THEN the system SHALL take a reversible action (quarantine pending admin review) rather than a 365-day hard disable, and the threshold SHALL be raised to a value that a single actor cannot reach cheaply from one address range.

2.16 WHEN an automatic quarantine is applied THEN the system SHALL bound its lifetime so the marker does not outlive the note's own TTL by an unbounded margin, and SHALL provide the owner a documented path to contest it.

2.17 WHEN multiple reports arrive from addresses within the same IPv6 /64 or IPv4 /24 THEN the system SHALL treat them as a single reporter for threshold purposes.

2.18 WHEN the interstitial page's report control is used THEN the system SHALL keep working end-to-end, including under the existing CSP (which already allows `challenges.cloudflare.com` in `script-src`, `frame-src`, and `connect-src`).

**Defect 4 — kind is decided once, at write time**

2.19 WHEN a note is created or its content is rewritten THEN the system SHALL persist the resolved kind as `k: "url" | "text"` in the `m:<name>` meta record.

2.20 WHEN a note is read THEN the system SHALL use the persisted `k` to choose between 302 redirect, interstitial, and rendered note page, and SHALL NOT re-derive the kind from content.

2.21 WHEN a meta record has no `k` field (created before this fix) THEN the system SHALL fall back to the current `isUrl(content)` derivation, so pre-existing records keep behaving exactly as they do today; the fallback window is bounded by the 7-day maximum TTL.

2.22 WHEN an edit does not supply new content (TTL change or `renew` only) THEN the system SHALL preserve the stored `k` unchanged.

2.23 WHEN an edit supplies new content THEN the system SHALL recompute and persist `k` for that new content, and that SHALL be the only way a note's kind changes.

2.24 WHEN kind is reported to any consumer (JSON `kind`, `X-Kind` header, admin note detail, result page) THEN the system SHALL report the same value that drives the read-time branch.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a URL note's target is on `REDIRECT_ALLOWLIST` THEN the system SHALL CONTINUE TO answer with `302` and a `location` header equal to the stored target.

3.2 WHEN a URL note's target is not on the allowlist THEN the system SHALL CONTINUE TO serve the interstitial page, and `?go=1` SHALL CONTINUE TO NOT bypass it (covered by the existing test in `test/api.test.ts`).

3.3 WHEN a text note is read THEN the system SHALL CONTINUE TO render it via `notePage`, and `/raw` SHALL CONTINUE TO return the stored bytes with `content-type: text/plain;charset=utf-8`.

3.4 WHEN an edit is submitted with a valid token in the JSON/form body THEN the system SHALL CONTINUE TO apply it, including the `content` / `ttl` / `renew` combinations documented in `docs/API.md` and the "each edit resets the expiry window" semantics.

3.5 WHEN an edit presents a wrong or missing token THEN the system SHALL CONTINUE TO return `invalid_token` (403) / `missing_token` (400) with the same JSON error envelope, and `not_editable` (403) when `m:<name>` is absent.

3.6 WHEN a create succeeds THEN the system SHALL CONTINUE TO return `201` with the same JSON fields (`apiVersion`, `name`, `kind`, `shortUrl`, `rawUrl`, `editToken`, `editUrl`, `ttl`, `createdAt`, `expiresAt`, `target`, `contentLength`) and the same `X-*` metadata headers, with `editToken` returned exactly once.

3.7 WHEN the edit link `https://<name>.0g.hk/edit#t=<token>` is opened THEN the system SHALL CONTINUE TO load the current content into the editor and save on click and on Cmd/Ctrl-S.

3.8 WHEN a moderation, brand, scheme, shortener, or Safe Browsing gate trips THEN the system SHALL CONTINUE TO return the same error codes and HTTP statuses, evaluated in the same order.

3.9 WHEN a client exceeds the create/edit rate limit THEN the system SHALL CONTINUE TO return `429 rate_limited` with `details.limit` and `details.windowSeconds: 60`.

3.10 WHEN a name is checked via `/exists` THEN the system SHALL CONTINUE TO return the same `valid` / `exists` / `reason` shapes, including `reserved` and `brand`.

3.11 WHEN a note is disabled (by an admin, or by the auto-action once its new threshold is met) THEN the system SHALL CONTINUE TO answer `410` with `disabled` in JSON mode and the styled status page in HTML mode.

3.12 WHEN the same reporter submits twice for the same name on the same day THEN the system SHALL CONTINUE TO dedupe and report `deduped: true`.

3.13 WHEN admin endpoints are called with a valid `ADMIN_KEY` THEN the system SHALL CONTINUE TO serve `/admin/stats`, `/admin/note`, `/admin/disable`, `/admin/enable`, `/admin/delete`, and `/admin/config` unchanged, and `/admin/enable` SHALL CONTINUE TO clear both `d:<name>` and `abuse:<name>`.

3.14 WHEN static assets are requested THEN the system SHALL CONTINUE TO serve `/llms.txt` and `/robots.txt` through the `ASSETS` binding, and `curl 0g.hk` SHALL CONTINUE TO return the plain-text manual.

3.15 WHEN `OPTIONS` is sent to any path THEN the system SHALL CONTINUE TO return the same 204 CORS preflight.

### Validation Notes

- `test/views.test.ts` holds HTML snapshots for `EditNotePage` and `InterstitialPage` (`test/__snapshots__/`). Changing their inline JS — which defects 1 and 3 both require — will fail those snapshots. The updates are **intentional** and must be reviewed as part of the change, not regenerated blindly; the review should confirm the new `EditNotePage` markup contains no token in any URL, and that the new `InterstitialPage` markup wires up the challenge.
- Tests for defect 2 must set a **distinct `cf-connecting-ip` header per request**. `rateLimit()` falls back to `ip = "0"` when the header is absent, so all header-less requests share one bucket and one `rej-ip:0` counter — which would make rejection-count and adaptive-cap assertions cross-contaminate. (The `"0"` fallback itself is a separate known issue and is out of scope here.)
- The existing `go=1` bypass test and the allowlist-302 test in `test/api.test.ts` are the load-bearing preservation checks for defect 4. They must pass unmodified.
- Baseline before the fix: `npx vitest run` → 27 passed; `npx tsc --noEmit` → clean (note `strict: false` in tsconfig, so type errors around the new `ctx` parameter will not be caught by the compiler alone).

## Bug Conditions and Correctness Properties

Notation: **F** = current code, **F'** = fixed code, **C(X)** = the buggy-input predicate.

### Defect 1 — edit token in URL / logs

```pascal
FUNCTION isBugCondition_1(X)
  INPUT: X of type EditRequest
  OUTPUT: boolean

  // Any edit whose token is carried in the request URL, or any
  // request whose emitted log line still contains the token.
  RETURN (X.token ≠ NULL) AND
         (tokenInRequestUrl(X) OR tokenInLogLine(emitLog(X)))
END FUNCTION
```

```pascal
// Property: Fix Checking — token confidentiality
FOR ALL X WHERE isBugCondition_1(X) DO
  response ← handleEdit'(X)
  logs     ← capturedLogLines(X)

  ASSERT FOR ALL line IN logs:      NOT containsToken(line, X.token)
  ASSERT FOR ALL h IN response.headers: NOT containsToken(h, X.token)
  ASSERT NOT containsToken(response.body, X.token)
END FOR
```

```pascal
// Property: Fix Checking — transport equivalence
FOR ALL (name, token, content, ttl) DO
  viaHeader ← handleEdit'(POST, name, headerToken := token, body := {content, ttl})
  viaBody   ← handleEdit'(POST, name, body := {token, content, ttl})
  viaQuery  ← handleEdit'(GET,  name, query := {edit: token, c: content, ttl})

  ASSERT viaHeader.status = viaBody.status = viaQuery.status
  ASSERT storedContentAfter(viaHeader) = storedContentAfter(viaBody)
                                       = storedContentAfter(viaQuery)
END FOR
```

```pascal
// Property: Fix Checking — no forged token ever authenticates
FOR ALL (name, realToken, forged) WHERE forged ≠ realToken DO
  r ← handleEdit'(name, token := forged)
  ASSERT r.status IN {400, 403}
  ASSERT storedContent(name) unchanged
END FOR
```

### Defect 2 — rejection telemetry

```pascal
FUNCTION isBugCondition_2(X)
  INPUT: X of type Sequence[WriteRequest]
  OUTPUT: boolean

  // Any request sequence containing at least one gate rejection.
  RETURN EXISTS r IN X WHERE isRejectedByGate(r)
END FUNCTION
```

```pascal
// Property: Fix Checking — rejection accounting is exact
FOR ALL X WHERE isBugCondition_2(X) DO
  // all requests in X share one ip, distinct from other test sequences
  n ← COUNT(r IN X WHERE isRejectedByGate(r))
  runAll'(X)

  ASSERT SUM(kv["rej:" + today + ":" + code] FOR code IN REJECT_CODES) = n
  ASSERT kv["rej-ip:" + X.ip] = n
END FOR
```

```pascal
// Property: Fix Checking — adaptive cap engages
FOR ALL X WHERE COUNT(r IN X WHERE isRejectedByGate(r)) ≥ ADAPTIVE_REJECT_THRESHOLD DO
  runAll'(X)
  accepted ← COUNT of subsequent same-minute, same-ip write requests that are NOT 429
  ASSERT accepted ≤ ADAPTIVE_RATE_LIMIT
END FOR
```

```pascal
// Property: Fix Checking — telemetry never blocks or breaks the response
FOR ALL X WHERE isBugCondition_2(X) DO
  ASSERT statusOf(F'(X)) = statusOf(F(X))
  ASSERT errorCodeOf(F'(X)) = errorCodeOf(F(X))
END FOR
```

### Defect 3 — abuse-report weaponisation

```pascal
FUNCTION isBugCondition_3(X)
  INPUT: X of type Sequence[AbuseReport] for a single name
  OUTPUT: boolean

  // Reports that are unverified, or that a single actor can generate
  // from one address range, or that reach the auto-action threshold
  // without independent reporters.
  RETURN (EXISTS r IN X WHERE NOT challengeVerified(r)) OR
         (COUNT(distinctReporterGroups(X)) = 1 AND LENGTH(X) ≥ ABUSE_AUTO_DISABLE)
END FUNCTION
```

```pascal
// Property: Fix Checking — sub-threshold reports never disable
FOR ALL n WHERE n < AUTO_ACTION_THRESHOLD DO
  X ← n reports for `name`, each from a distinct verified reporter group
  runAll'(X)
  ASSERT kv["d:" + name] = NULL
  ASSERT GET("https://" + name + ".0g.hk/").status ≠ 410
  ASSERT kv["abuse:" + name] = n
END FOR
```

```pascal
// Property: Fix Checking — one address range counts once
FOR ALL X WHERE COUNT(distinctReporterGroups(X)) = 1 DO
  runAll'(X)
  ASSERT kv["abuse:" + name] ≤ 1
  ASSERT kv["d:" + name] = NULL
END FOR
```

```pascal
// Property: Fix Checking — unverified reports are inert
FOR ALL X WHERE TURNSTILE_SECRET is set AND NOT challengeVerified(X) DO
  before ← kv["abuse:" + name]
  r ← handleAbuseReport'(X)
  ASSERT r.status ≥ 400
  ASSERT kv["abuse:" + name] = before
  ASSERT kv["d:" + name] = NULL
END FOR
```

```pascal
// Property: Fix Checking — automatic action is reversible and bounded
FOR ALL X WHERE autoActionTriggered'(X) DO
  ASSERT markerTtlSeconds(kv["d:" + name]) ≤ AUTO_ACTION_MARKER_MAX_TTL
  adminEnable(name)
  ASSERT kv["d:" + name] = NULL AND kv["abuse:" + name] = NULL
  ASSERT GET("https://" + name + ".0g.hk/").status ≠ 410
END FOR
```

### Defect 4 — unpersisted note kind

```pascal
FUNCTION isBugCondition_4(X)
  INPUT: X of type Note
  OUTPUT: boolean

  // Any note whose meta lacks a persisted kind, or whose read-time
  // derivation disagrees with the kind resolved when it was written.
  RETURN (meta(X).k = UNDEFINED) OR
         (isUrl(content(X)) ≠ (kindAtWriteTime(X) = "url"))
END FUNCTION
```

```pascal
// Property: Fix Checking — kind is persisted and authoritative
FOR ALL X WHERE isBugCondition_4(X) DO
  created ← handleCreate'(X)
  ASSERT meta(X).k IN {"url", "text"}
  ASSERT meta(X).k = created.json.kind = created.headers["x-kind"]
  ASSERT readBranch'(X) = (meta(X).k = "url" ? (isAllowedTarget ? REDIRECT : INTERSTITIAL) : RENDER)
END FOR
```

```pascal
// Property: Fix Checking — kind is invariant across reads
FOR ALL X, FOR ALL k ≥ 1 DO
  kinds ← [ read'(X).kind FOR i IN 1..k ]
  ASSERT allEqual(kinds)
END FOR
```

```pascal
// Property: Fix Checking — kind changes only on explicit content rewrite
FOR ALL X, FOR ALL op IN {renew, changeTtl, readRaw, readJson, readHtml} DO
  k0 ← meta(X).k
  apply'(op, X)
  ASSERT meta(X).k = k0
END FOR

FOR ALL X, FOR ALL newContent DO
  edit'(X, content := newContent)
  ASSERT meta(X).k = resolveKind(newContent)
END FOR
```

```pascal
// Property: Fix Checking — legacy records are unaffected
FOR ALL X WHERE meta(X) written by F (no `k` field) DO
  ASSERT readBranch'(X) = readBranch(X)   // identical to pre-fix behavior
  ASSERT read'(X).kind = (isUrl(content(X)) ? "url" : "text")
END FOR
```

### Preservation Checking (all four defects)

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT (isBugCondition_1(X) OR isBugCondition_2(X)
                  OR isBugCondition_3(X) OR isBugCondition_4(X)) DO
  ASSERT F(X) = F'(X)
END FOR
```

Observationally, equality is checked over: HTTP status, JSON error `code`, all `X-*` metadata headers, `location` on 302, `/raw` bytes, and the resulting KV state for `n:<name>` and `m:<name>` (excluding the newly added `k` field).
