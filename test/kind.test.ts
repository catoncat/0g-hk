// FIX-CHECKING TESTS FOR D4 — Properties 11-15 (task 5.6).
//
// These run against the FIXED code (tasks 5.1-5.5) and are expected to PASS.
//
// The defect these lock down: `m:<name>` used to carry no kind at all, so the
// security-relevant branch on the read path (302 redirect vs interstitial vs
// rendered note) was decided by re-running `URL_NO_SCHEME_RE` on every single
// read, in five separate places. The claim now is that the kind is resolved
// ONCE at write time, persisted as `k`, and that every consumer reports the
// same value the branch actually used.
//
// TWO HARNESS REQUIREMENTS APPLY (design.md, *Validation Approach*):
//
// (a) LOG CAPTURE + NON-VACUITY. Not exercised here — no assertion in this file
//     concerns log output. It is D1's concern (task 6.11). Noted so the omission
//     is visibly deliberate rather than forgotten.
//
// (b) A DISTINCT `cf-connecting-ip` PER REQUEST, via `nextIp()`. `rateLimit()`
//     falls back to `ip = "0"` when the header is absent, so header-less
//     requests share one `rl:0:<minute>` bucket. Every create/edit below passes
//     through that limiter, and the property tests issue dozens of them, so a
//     shared bucket would produce spurious 429s and fail these properties for a
//     reason that has nothing to do with kind.
import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { nextIp } from "./helpers.js";
import {
  arbBoundaryContent,
  arbBoundaryRewrite,
  fcParams,
  nextName,
  RUNS_WORKER,
} from "./arbitraries.js";
import { resolveKind, sha256Base64Url } from "../src/util.js";

const APEX = "https://0g.hk";

// github.com is on REDIRECT_ALLOWLIST; untrusted.example deliberately is not.
const ALLOWLISTED = "https://github.com/catoncat/0g-hk";
const NOT_ALLOWLISTED = "https://untrusted.example/path";

function jsonHeaders(ip: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", accept: "application/json", "cf-connecting-ip": ip, ...extra };
}

async function createJson(body: Record<string, any>): Promise<Response> {
  return SELF.fetch(`${APEX}/`, {
    method: "POST",
    headers: jsonHeaders(nextIp()),
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

/** Create a note, returning its edit token. Throws if the create was rejected. */
async function seed(name: string, content: string, ttl?: string): Promise<string> {
  const res = await createJson({ name, content, ...(ttl ? { ttl } : {}) });
  const j: any = await res.json();
  if (!j.editToken) throw new Error(`seed failed for ${name}: ${res.status} ${JSON.stringify(j)}`);
  return j.editToken as string;
}

async function editJson(name: string, body: Record<string, any>): Promise<Response> {
  return SELF.fetch(`https://${name}.0g.hk/`, {
    method: "POST",
    headers: jsonHeaders(nextIp()),
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(url, { headers: { "cf-connecting-ip": nextIp(), ...headers }, redirect: "manual" });
}

/** The parsed `m:<name>` record, or null. */
async function meta(name: string): Promise<any> {
  const raw = await env.NOTES.get("m:" + name);
  return raw == null ? null : JSON.parse(raw);
}

/** The raw `m:<name>` bytes — needed to tell "k absent" from "k undefined". */
async function metaRaw(name: string): Promise<string | null> {
  return env.NOTES.get("m:" + name);
}

/** Whether the stored meta record has a `k` field at all. */
async function hasK(name: string): Promise<boolean> {
  const m = await meta(name);
  return m != null && Object.prototype.hasOwnProperty.call(m, "k");
}

type Branch = "redirect" | "interstitial" | "note";

/**
 * Which read branch actually answered, observed from the response rather than
 * inferred. This is the whole point of Property 11: the persisted `k` must be
 * the value that selects this.
 */
async function readBranch(name: string): Promise<{ branch: Branch; location: string | null; status: number }> {
  const res = await get(`https://${name}.0g.hk/`, { accept: "text/html" });
  const status = res.status;
  const location = res.headers.get("location");
  if (status === 302) {
    await res.text();
    return { branch: "redirect", location, status };
  }
  const body = await res.text();
  // The interstitial is the only page carrying this warning heading.
  const branch: Branch = body.includes("即将离开") ? "interstitial" : "note";
  return { branch, location, status };
}

/** The kind as every consumer reports it. */
async function reportedKinds(name: string, adminKey?: string): Promise<Record<string, any>> {
  const jsonRes = await get(`https://${name}.0g.hk/?format=json`);
  const j: any = await jsonRes.json();
  const rawRes = await get(`https://${name}.0g.hk/raw`);
  await rawRes.text();
  const out: Record<string, any> = {
    json: j.kind,
    xKindOnJson: jsonRes.headers.get("x-kind"),
    xKindOnRaw: rawRes.headers.get("x-kind"),
  };
  if (adminKey) {
    const a = await get(`${APEX}/admin/note?name=${name}`, {
      accept: "application/json",
      authorization: `Bearer ${adminKey}`,
    });
    const aj: any = await a.json();
    out.admin = aj.kind;
  }
  return out;
}

/** The branch the persisted kind implies, per design.md's Property 11. */
function branchFor(kind: string, target: string | null): Branch {
  if (kind !== "url") return "note";
  return target && isAllowlistedHost(target) ? "redirect" : "interstitial";
}

function isAllowlistedHost(target: string): boolean {
  try {
    const h = new URL(target).hostname.toLowerCase();
    return h === "github.com" || h.endsWith(".github.com");
  } catch {
    return false;
  }
}

// ===========================================================================
// Property 11 — kind is persisted and authoritative
// ===========================================================================

describe("Property 11: kind is persisted and authoritative (2.19, 2.20, 2.24)", () => {
  const CASES: Array<{ label: string; content: string; kind: string; branch: Branch }> = [
    { label: "URL note with an allowlisted target", content: ALLOWLISTED, kind: "url", branch: "redirect" },
    { label: "URL note with a non-allowlisted target", content: NOT_ALLOWLISTED, kind: "url", branch: "interstitial" },
    { label: "text note", content: "hello **bold** kind", kind: "text", branch: "note" },
  ];

  it.each(CASES)("$label persists k and the branch follows it", async ({ content, kind, branch }) => {
    const name = nextName("p11");
    await seed(name, content);

    // 1. the kind is actually on disk
    const m = await meta(name);
    expect(m.k, "m:<name>.k must be persisted at write time").toBe(kind);

    // 2. every consumer agrees with it
    const reported = await reportedKinds(name);
    expect(reported.json).toBe(kind);
    expect(reported.xKindOnJson).toBe(kind);
    expect(reported.xKindOnRaw).toBe(kind);

    // 3. and it is the value that selected the read branch
    const observed = await readBranch(name);
    expect(observed.branch, `persisted k=${kind} must select the ${branch} branch`).toBe(branch);
    if (branch === "redirect") {
      expect(observed.status).toBe(302);
      expect(observed.location, "the 302 target must be the stored content (3.1)").toBe(content);
    }
  });

  // The hand-written cases above sit on three comfortable happy paths. The real
  // risk is content that straddles URL_NO_SCHEME_RE, where a write-time
  // decision and a read-time re-derivation are most likely to disagree.
  it("persisted k always equals the branch actually taken, across generated boundary content", async () => {
    await fc.assert(
      fc.asyncProperty(arbBoundaryContent, async ({ content, category }) => {
        const name = nextName("p11g");
        const res = await createJson({ name, content });
        const j: any = await res.json();
        expect(res.status, `create rejected for ${category}: ${JSON.stringify(content)} -> ${JSON.stringify(j)}`).toBe(201);

        const m = await meta(name);
        expect(m.k, `${category}: k must be url or text`).toMatch(/^(url|text)$/);
        expect(m.k, `${category}: k must equal the response kind`).toBe(j.kind);
        expect(res.headers.get("x-kind"), `${category}: x-kind must equal k`).toBe(m.k);
        // The writer normalizes a URL, so compare against the STORED target.
        const observed = await readBranch(name);
        expect(observed.branch, `${category}: ${JSON.stringify(content)} k=${m.k} target=${j.target}`).toBe(
          branchFor(m.k, j.target),
        );
      }),
      fcParams(RUNS_WORKER),
    );
  });
});

// ===========================================================================
// Property 12 — kind is invariant across reads
// ===========================================================================

describe("Property 12: kind is invariant across reads (2.20, 2.24)", () => {
  it("every reported kind is equal, over repeated reads across all four surfaces", async () => {
    const ADMIN_KEY = "p12-admin-key";
    const prev = (env as any).ADMIN_KEY;
    (env as any).ADMIN_KEY = ADMIN_KEY;
    try {
      await fc.assert(
        fc.asyncProperty(arbBoundaryContent, async ({ content, category }) => {
          const name = nextName("p12");
          const res = await createJson({ name, content });
          const j: any = await res.json();
          expect(res.status, `create rejected for ${category}`).toBe(201);

          // Five rounds across /, /raw, ?format=json and /admin/note. A
          // read-time re-derivation would be stable too, so what this really
          // pins is that no surface disagrees with the others.
          const seen: any[] = [];
          for (let i = 0; i < 5; i++) {
            const r = await reportedKinds(name, ADMIN_KEY);
            seen.push(r);
          }
          for (const r of seen) {
            expect(
              new Set([r.json, r.xKindOnJson, r.xKindOnRaw, r.admin]).size,
              `${category}: surfaces disagreed: ${JSON.stringify(r)}`,
            ).toBe(1);
            expect(r.json, `${category}: drifted from the persisted kind`).toBe(j.kind);
          }
        }),
        fcParams(RUNS_WORKER),
      );
    } finally {
      if (prev === undefined) delete (env as any).ADMIN_KEY;
      else (env as any).ADMIN_KEY = prev;
    }
  });
});

// ===========================================================================
// Property 13 — kind survives non-content operations
// ===========================================================================

describe("Property 13: kind survives non-content operations (2.22)", () => {
  // design.md: "For any note and any operation in {renew, changeTtl, readRaw,
  // readJson, readHtml}, m:<name>.k SHALL be byte-for-byte what it was before
  // the operation, INCLUDING REMAINING ABSENT ON LEGACY RECORDS."
  //
  // The legacy row is the load-bearing one: backfilling `k` on a TTL-only edit
  // would be observationally harmless (the value equals the fallback) but would
  // falsify this property, which is exactly why design.md rejected it.

  /** Seed a record the way the PRE-FIX code did: meta with no `k`. */
  async function seedLegacy(name: string, content: string, ttl = "7d"): Promise<string> {
    const token = "legacy-token-" + name;
    const h = await sha256Base64Url(token);
    await env.NOTES.put("n:" + name, content);
    await env.NOTES.put("m:" + name, JSON.stringify({ v: 1, h, t: ttl, ct: Date.now() }));
    return token;
  }

  it("a URL note keeps its persisted k across renew, ttl change and every read", async () => {
    const name = nextName("p13u");
    const token = await seed(name, ALLOWLISTED);
    expect((await meta(name)).k).toBe("url");

    for (const patch of [{ renew: true }, { ttl: "1d" }, { renew: "1", ttl: "1h" }]) {
      const res = await editJson(name, { token, ...patch });
      expect(res.status, `edit ${JSON.stringify(patch)} must succeed`).toBe(200);
      const j: any = await res.json();
      expect(j.kind, "the reported kind must still be the stored one").toBe("url");
      expect((await meta(name)).k, `k must be untouched by ${JSON.stringify(patch)}`).toBe("url");
    }

    for (const path of ["/", "/raw", "/?format=json"]) {
      const r = await get(`https://${name}.0g.hk${path}`, { accept: "text/html" });
      await r.text();
      expect((await meta(name)).k, `k must be untouched by a read of ${path}`).toBe("url");
    }
  });

  it("a text note keeps its persisted k across renew, ttl change and every read", async () => {
    const name = nextName("p13t");
    const token = await seed(name, "plain text kind stability");
    expect((await meta(name)).k).toBe("text");

    for (const patch of [{ renew: true }, { ttl: "1d" }]) {
      const res = await editJson(name, { token, ...patch });
      expect(res.status).toBe(200);
      expect((await meta(name)).k).toBe("text");
    }
    for (const path of ["/", "/raw", "/?format=json"]) {
      const r = await get(`https://${name}.0g.hk${path}`, { accept: "text/html" });
      await r.text();
      expect((await meta(name)).k).toBe("text");
    }
  });

  it("a LEGACY record with no k still has no k after renew, ttl change and reads", async () => {
    const name = nextName("p13l");
    const token = await seedLegacy(name, "legacy text note");
    expect(await hasK(name), "the seeded record must start with no k at all").toBe(false);

    // A renew rewrites the meta record (ct moves), which is precisely the
    // opportunity a backfill would take. It must not.
    const ctBefore = (await meta(name)).ct;
    const renewed = await editJson(name, { token, renew: true });
    expect(renewed.status).toBe(200);
    const renewedJson: any = await renewed.json();
    expect(renewedJson.kind, "the legacy fallback still reports the derived kind").toBe("text");
    expect((await meta(name)).ct, "the record really was rewritten").not.toBe(ctBefore);
    expect(await hasK(name), "k must STILL be absent — no backfill on a no-content edit").toBe(false);
    expect(await metaRaw(name)).not.toContain('"k"');

    const ttlChanged = await editJson(name, { token, ttl: "1d" });
    expect(ttlChanged.status).toBe(200);
    expect(await hasK(name), "a ttl-only edit must not backfill k either").toBe(false);

    for (const path of ["/", "/raw", "/?format=json"]) {
      const r = await get(`https://${name}.0g.hk${path}`, { accept: "text/html" });
      await r.text();
      expect(await hasK(name), `a read of ${path} must not write anything`).toBe(false);
    }
  });
});

// ===========================================================================
// Property 14 — kind is recomputed only on content rewrite
// ===========================================================================

describe("Property 14: kind is recomputed only on content rewrite (2.23)", () => {
  it("an explicit content rewrite persists resolveKind(newContent), and the branch follows", async () => {
    await fc.assert(
      fc.asyncProperty(arbBoundaryRewrite, async ({ from, to }) => {
        const name = nextName("p14");
        const createRes = await createJson({ name, content: from.content });
        const cj: any = await createRes.json();
        expect(createRes.status, `create rejected for ${from.category}`).toBe(201);
        expect((await meta(name)).k).toBe(resolveKind(from.content));

        // The edit token is only ever returned once, at create.
        const editRes = await editJson(name, { token: cj.editToken, content: to.content });
        const ej: any = await editRes.json();
        expect(editRes.status, `edit rejected for ${to.category}: ${JSON.stringify(ej)}`).toBe(200);

        const expected = resolveKind(to.content);
        expect(ej.kind, `${to.category}: response kind must be the recomputed one`).toBe(expected);
        expect(editRes.headers.get("x-kind")).toBe(expected);
        expect((await meta(name)).k, `${to.category}: k must be recomputed on a content rewrite`).toBe(expected);

        const observed = await readBranch(name);
        expect(observed.branch, `${to.category}: the read branch must follow the new k`).toBe(
          branchFor(expected, ej.target),
        );
      }),
      fcParams(RUNS_WORKER),
    );
  });

  // The exploratory case-8 scenario, now asserting the flip is RECORDED rather
  // than silent. The flip is still allowed; what changed is that it only
  // happens on an explicit content rewrite and leaves a trace.
  it("the text -> url flip from exploratory case 8 is recorded in k", async () => {
    const name = nextName("p14flip");
    const token = await seed(name, "hello world");
    expect((await meta(name)).k).toBe("text");
    expect((await readBranch(name)).branch).toBe("note");

    const res = await editJson(name, { token, content: "docs.example.com" });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.kind).toBe("url");
    expect((await meta(name)).k).toBe("url");
    // docs.example.com is not on REDIRECT_ALLOWLIST, so url => interstitial.
    expect((await readBranch(name)).branch).toBe("interstitial");
  });
});

// ===========================================================================
// Property 15 — legacy records are unaffected
// ===========================================================================

describe("Property 15: legacy records are unaffected (2.21)", () => {
  // The ONLY test that constructs KV state by hand: it has to, because the
  // fixed code cannot produce a meta record without `k`, and pre-fix records
  // are exactly what must keep working. The 7-day maximum TTL bounds how long
  // such records can exist in production, which is why the fallback is
  // temporary — but while it exists it must be exact.
  const LEGACY: Array<{ label: string; content: string; kind: string; branch: Branch }> = [
    { label: "allowlisted URL", content: ALLOWLISTED, kind: "url", branch: "redirect" },
    { label: "non-allowlisted URL", content: NOT_ALLOWLISTED, kind: "url", branch: "interstitial" },
    { label: "plain text", content: "legacy plain text", kind: "text", branch: "note" },
  ];

  it.each(LEGACY)("a legacy $label record behaves exactly as it did pre-fix", async ({ content, kind, branch }) => {
    const name = nextName("p15");
    await env.NOTES.put("n:" + name, content);
    await env.NOTES.put("m:" + name, JSON.stringify({ v: 1, h: "x".repeat(43), t: "7d", ct: Date.now() }));
    expect(await hasK(name), "the fixture must have no k").toBe(false);

    // The reported kind is the pre-fix derivation, isUrl(content).
    expect(kind, "sanity: the expectation matches resolveKind").toBe(resolveKind(content));
    const reported = await reportedKinds(name);
    expect(reported.json).toBe(kind);
    expect(reported.xKindOnJson).toBe(kind);

    const observed = await readBranch(name);
    expect(observed.branch, "the branch must be the pre-fix one").toBe(branch);
    if (branch === "redirect") expect(observed.location).toBe(content);

    // And reading never writes.
    expect(await hasK(name)).toBe(false);
  });
});
