import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const APEX = "https://0g.hk";

describe("Performance Baseline", () => {
  it("measures handleCreate and handleEdit latency", async () => {
    const name = `perf${Math.random().toString(36).slice(2, 9)}`;

    // Measure handleCreate
    const startCreate = performance.now();
    const createRes = await SELF.fetch(`${APEX}/`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ name, content: "perf test content" }),
    });
    const endCreate = performance.now();
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json<any>();
    const token = createJson.editToken;
    console.log(`handleCreate took ${endCreate - startCreate}ms`);

    // Measure handleEdit
    const startEdit = performance.now();
    const editRes = await SELF.fetch(`https://${name}.0g.hk/`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token, content: "updated perf test content" }),
    });
    const endEdit = performance.now();
    expect(editRes.status).toBe(200);
    console.log(`handleEdit took ${endEdit - startEdit}ms`);

    // Run multiple times to get an average
    const iterations = 10;
    let totalCreateTime = 0;
    let totalEditTime = 0;

    for (let i = 0; i < iterations; i++) {
      const iterName = `perf${i}${Math.random().toString(36).slice(2, 5)}`;

      const sC = performance.now();
      const resC = await SELF.fetch(`${APEX}/`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ name: iterName, content: "perf test content" }),
      });
      totalCreateTime += (performance.now() - sC);
      const jsonC = await resC.json<any>();
      const tok = jsonC.editToken;

      const sE = performance.now();
      await SELF.fetch(`https://${iterName}.0g.hk/`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token: tok, content: "updated" }),
      });
      totalEditTime += (performance.now() - sE);
    }

    console.log(`Average handleCreate (${iterations} iterations): ${totalCreateTime / iterations}ms`);
    console.log(`Average handleEdit (${iterations} iterations): ${totalEditTime / iterations}ms`);
  });
});
