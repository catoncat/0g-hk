// Smoke tests for the public HTTP API. Exercises the deployed Worker (apex
// router) via SELF.fetch from @cloudflare/vitest-pool-workers — same bundle,
// real Hono routes, KV-mocked.
import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const APEX = "https://0g.hk";

describe("GET /exists", () => {
  it("reports a free name as valid + not-existing", async () => {
    const res = await SELF.fetch(`${APEX}/exists?n=freshslug42`);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toMatchObject({ valid: true, exists: false });
  });

  it("blocks brand-squatting names (phishing gate)", async () => {
    // Brand list lives in src/util.ts -> isBrandSquatting; "paypal" is one of
    // the canonical brand-squat trip wires.
    const res = await SELF.fetch(`${APEX}/exists?n=paypal`);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe("brand");
  });

  it("rejects reserved names", async () => {
    const res = await SELF.fetch(`${APEX}/exists?n=admin`);
    const body = await res.json<any>();
    expect(body.valid).toBe(false);
    expect(["reserved", "invalid"]).toContain(body.reason);
  });
});

describe("create + fetch round-trip", () => {
  it("persists a note then serves it on the subdomain", async () => {
    const name = `t${Math.random().toString(36).slice(2, 9)}`;
    const create = await SELF.fetch(`${APEX}/`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ name, content: "hello vitest **bold**" }),
    });
    expect(create.status, await create.clone().text()).toBeLessThan(400);

    const view = await SELF.fetch(`https://${name}.0g.hk/`, {
      headers: { accept: "text/plain" },
    });
    expect(view.status).toBe(200);
    const text = await view.text();
    // Plain-text accept returns the raw stored content; HTML accept renders MD.
    expect(text).toContain("hello vitest");
  });

  it("does not let go=1 bypass the external-link warning", async () => {
    const unsafeName = `ext${Math.random().toString(36).slice(2, 9)}`;
    const unsafeCreate = await SELF.fetch(`${APEX}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
      },
      body: JSON.stringify({ name: unsafeName, content: "https://untrusted.example/path?x=1" }),
    });
    expect(unsafeCreate.status, await unsafeCreate.clone().text()).toBe(201);

    const unsafeView = await SELF.fetch(`https://${unsafeName}.0g.hk/?go=1`, { redirect: "manual" });
    expect(unsafeView.status).not.toBe(302);
    expect(await unsafeView.text()).toContain("即将离开");

    const safeName = `gh${Math.random().toString(36).slice(2, 9)}`;
    const safeTarget = "https://github.com/catoncat/0g-hk";
    const safeCreate = await SELF.fetch(`${APEX}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
      },
      body: JSON.stringify({ name: safeName, content: safeTarget }),
    });
    expect(safeCreate.status, await safeCreate.clone().text()).toBe(201);

    const safeView = await SELF.fetch(`https://${safeName}.0g.hk/`, { redirect: "manual" });
    expect(safeView.status).toBe(302);
    expect(safeView.headers.get("location")).toBe(safeTarget);
  });
});

describe("static assets (0X0-14)", () => {
  it("serves /llms.txt from public/ via env.ASSETS", async () => {
    // In miniflare, SELF goes straight to the worker; in production CF
    // routes /llms.txt through the ASSETS binding upstream of fetch().
    // We exercise the same binding directly.
    const res = await env.ASSETS.fetch("https://0g.hk/llms.txt");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toMatch(/0g\.hk/);
  });

  it("serves /robots.txt with the llms.txt allow rule", async () => {
    const res = await env.ASSETS.fetch("https://0g.hk/robots.txt");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Allow:\s*\/llms\.txt/);
  });
});
