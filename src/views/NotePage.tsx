// Public note view: renders Markdown to HTML inside a styled article. Short
// plain-text notes get an oversized centered layout ("big" mode) so a 2-word
// note still looks intentional. A hidden textarea holds the raw source for
// the header's copy button.
import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { BASE_HOST } from "../constants.js";
import { renderMarkdown } from "../markdown.js";
import { html } from "../responses.js";
import { Layout, renderDoc } from "./Layout.js";
import { Header } from "./Header.js";
import { Footer } from "./Footer.js";
import { Promo } from "./Promo.js";

const EXTRA_CSS = `.markdown-body{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(1rem,3vw,1.35rem);font-size:1rem;line-height:1.72;color:var(--text);overflow-wrap:anywhere}
.markdown-body>:first-child{margin-top:0}.markdown-body>:last-child{margin-bottom:0}
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6{line-height:1.25;margin:1.2em 0 .55em;letter-spacing:0;color:var(--text)}
.markdown-body h1{font-size:1.65rem}.markdown-body h2{font-size:1.35rem}.markdown-body h3{font-size:1.12rem}.markdown-body h4,.markdown-body h5,.markdown-body h6{font-size:1rem}
.markdown-body p{margin:.72em 0}.markdown-body a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}.markdown-body strong{font-weight:700}.markdown-body del{color:var(--muted)}
.markdown-body ul,.markdown-body ol{padding-left:1.35rem;margin:.75em 0}.markdown-body li+li{margin-top:.28em}
.markdown-body blockquote{margin:.95em 0;padding:.1rem 0 .1rem .9rem;border-left:3px solid var(--border-strong);color:var(--muted)}
.markdown-body code{font-family:var(--mono);font-size:.9em;background:rgba(128,128,128,.14);border:1px solid var(--border);border-radius:4px;padding:.08rem .28rem}
.markdown-body pre{margin:1em 0;padding:.9rem 1rem;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;overflow:auto;line-height:1.58;-webkit-overflow-scrolling:touch}
.markdown-body pre code{display:block;background:transparent;border:0;border-radius:0;padding:0;white-space:pre;font-size:.88rem;color:var(--text)}
.markdown-body hr{border:0;border-top:1px solid var(--border);margin:1.25rem 0}
.markdown-body table{border-collapse:collapse;margin:1em 0;display:block;overflow-x:auto;max-width:100%;font-size:.95rem;-webkit-overflow-scrolling:touch}
.markdown-body table th,.markdown-body table td{border:1px solid var(--border);padding:.45rem .7rem;text-align:left;vertical-align:top}
.markdown-body table th{background:var(--surface-2);font-weight:600}
.markdown-body table tr:nth-child(2n) td{background:rgba(128,128,128,.05)}
.markdown-body.big{font-size:clamp(1.3rem,4vw,1.8rem);line-height:1.45;text-align:center;padding:clamp(1.5rem,5vw,2.25rem) clamp(1rem,3vw,1.25rem);font-weight:500}
.raw-copy{position:absolute;left:-9999px;top:auto;width:1px;height:1px;opacity:0}`;

const COPY_ONCLICK = `navigator.clipboard.writeText(document.getElementById('raw-copy').value).then(function(){var b=event.currentTarget;b.textContent='已复制';setTimeout(function(){b.textContent='复制'},1200)})`;

const HeaderRight: FC = () => (
  <div class="seg">
    <button type="button" onclick={COPY_ONCLICK}>复制</button>
    <a href="/raw">原文</a>
  </div>
);

const Note: FC<{ sub: string; content: string }> = ({ sub, content }) => {
  const isShortPlain = content.length <= 40 && !/[#*_`>\[\]-]|\n/.test(content);
  const bodyClass = isShortPlain ? "markdown-body big" : "markdown-body";
  return (
    <Layout
      title={`${sub} · ${BASE_HOST}`}
      extraCss={EXTRA_CSS}
      noindex
    >
      <div class="wrap">
        <Header right={<HeaderRight />} />
        <textarea id="raw-copy" class="raw-copy" readonly>{content}</textarea>
        <article id="c" class={bodyClass}>{raw(renderMarkdown(content))}</article>
        <Promo />
        <Footer />
      </div>
    </Layout>
  );
};

export function notePage(sub: string, content: string) {
  return html(renderDoc(<Note sub={sub} content={content} />));
}
