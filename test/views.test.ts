// Snapshot tests for the JSX views. First run creates a baseline; future
// changes must update snapshots intentionally (vitest -u). These pin the
// rendered HTML so we catch accidental drift across page rewrites.
import { describe, it, expect } from "vitest";
import {
  editorPage,
  resultPage,
  notePage,
  interstitialPage,
  editNotePage,
  notFoundPage,
} from "../src/views/index.js";

async function bodyOf(res: Response): Promise<string> {
  return await res.text();
}

describe("views", () => {
  it("editorPage — default", async () => {
    const r = editorPage();
    expect(await bodyOf(r)).toMatchSnapshot();
  });

  it("editorPage — with prefill + error", async () => {
    const r = editorPage({
      prefillName: "hello",
      prefillContent: "some text",
      prefillTtl: "1d",
      errorName: "“hello” 已被占用",
      alertTop: "请先阅读服务条款",
    });
    expect(await bodyOf(r)).toMatchSnapshot();
  });

  it("resultPage — created, text, with edit token", async () => {
    const r = resultPage("demo", "hello world", "created", "7d", "tok123");
    expect(await bodyOf(r)).toMatchSnapshot();
  });

  it("resultPage — updated, url, allowed", async () => {
    const r = resultPage("demo", "https://example.com/path", "updated", "1d", null);
    expect(await bodyOf(r)).toMatchSnapshot();
  });

  it("resultPage — created, url, not allowlisted (whitelist warning)", async () => {
    const r = resultPage("demo", "https://random-host.example/x", "created", "7d", "tok456");
    expect(await bodyOf(r)).toMatchSnapshot();
  });

  it("notePage — short plain text (big mode)", async () => {
    const r = notePage("demo", "hello");
    expect(await bodyOf(r)).toMatchSnapshot();
  });

  it("notePage — markdown", async () => {
    const r = notePage("demo", "# Title\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two");
    expect(await bodyOf(r)).toMatchSnapshot();
  });

  it("interstitialPage", async () => {
    const r = interstitialPage("demo", "https://untrusted.example/path?x=1");
    expect(await bodyOf(r)).toMatchSnapshot();
  });

  it("editNotePage", async () => {
    const r = editNotePage("demo", "7d");
    expect(await bodyOf(r)).toMatchSnapshot();
  });

  it("notFoundPage", async () => {
    const r = notFoundPage("demo");
    expect(r.status).toBe(404);
    expect(await bodyOf(r)).toMatchSnapshot();
  });
});
