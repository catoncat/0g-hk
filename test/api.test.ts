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
