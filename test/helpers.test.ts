// Self-checks for the harness in test/helpers.ts. A silent harness failure
// (a spy that captures nothing, a non-vacuity guard that never fires, an IP
// minter that returns the same address twice) would turn later security
// assertions green for the wrong reason, so the harness gets its own tests.
import { describe, it, expect } from "vitest";
import { captureLogs, expectRedactedLogPresent, nextIp, REDACTED_MARKER } from "./helpers.js";

describe("captureLogs", () => {
  it("captures log, error, warn and info, joining every argument", () => {
    const cap = captureLogs();
    try {
      console.log("<--", "GET /?c=x");
      console.error("boom", { code: 500 });
      console.warn("careful");
      console.info("fyi");
    } finally {
      cap.restore();
    }
    expect(cap.lines).toEqual(["<-- GET /?c=x", 'boom {"code":500}', "careful", "fyi"]);
    expect(cap.text()).toContain("GET /?c=x");
  });

  it("stops capturing after restore", () => {
    const cap = captureLogs();
    console.log("captured");
    cap.restore();
    console.log("not captured");
    expect(cap.lines).toEqual(["captured"]);
  });
});

describe("expectRedactedLogPresent (non-vacuity guard)", () => {
  it("passes when a redacted line was emitted", () => {
    expect(() => expectRedactedLogPresent([`<-- GET /?${REDACTED_MARKER}&c=x`])).not.toThrow();
  });

  it("fails when no line was emitted at all — the vacuous case it exists to catch", () => {
    expect(() => expectRedactedLogPresent([])).toThrow(/non-vacuity guard/);
  });

  it("fails when lines were emitted but none was redacted", () => {
    expect(() => expectRedactedLogPresent(["<-- GET /?c=x", "--> GET / 200 1ms"])).toThrow(/non-vacuity guard/);
  });
});

describe("nextIp", () => {
  it("mints a distinct address on every call", () => {
    const ips = new Set(Array.from({ length: 600 }, () => nextIp()));
    expect(ips.size).toBe(600);
    for (const ip of ips) expect(ip).toMatch(/^198\.51\.1\d\d\.\d{1,3}$/);
  });
});
