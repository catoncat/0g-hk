// Pure-function baseline for the markdown renderer. Locks in the inline
// transforms we rely on for note pages so future refactors stay safe.
import { describe, it, expect } from "vitest";
import { renderMarkdownInline, renderMarkdown } from "../src/markdown.js";

describe("renderMarkdownInline", () => {
  it("bold / italic / strike / code", () => {
    expect(renderMarkdownInline("**a**")).toContain("<strong>a</strong>");
    expect(renderMarkdownInline("*a*")).toContain("<em>a</em>");
    expect(renderMarkdownInline("~~a~~")).toContain("<del>a</del>");
    expect(renderMarkdownInline("`x`")).toContain("<code>x</code>");
  });

  it("escapes html", () => {
    expect(renderMarkdownInline("<script>")).not.toContain("<script>");
  });

  it("safe links: http allowed, javascript: stripped", () => {
    const ok = renderMarkdownInline("[x](https://example.com)");
    expect(ok).toMatch(/<a [^>]*href="https:\/\/example\.com"/);
    expect(ok).toContain('rel="noopener noreferrer"');

    const bad = renderMarkdownInline("[x](javascript:alert(1))");
    expect(bad).not.toMatch(/<a /);
  });
});

describe("renderMarkdown (block)", () => {
  it("wraps paragraphs and preserves fenced code", () => {
    const html = renderMarkdown("hello world\n\n```js\nconst a=1;\n```\n");
    expect(html).toContain("<p>hello world</p>");
    expect(html).toMatch(/<pre><code class="language-js">const a=1;<\/code><\/pre>/);
  });
});
