// 404 page shown when a subdomain has no note. Doubles as a soft promo —
// invites the visitor to claim the slug. Status 404 is set by the caller.
import type { FC } from "hono/jsx";
import { BASE_HOST } from "../constants.js";
import { html } from "../responses.js";
import { Layout, renderDoc } from "./Layout.js";
import { Header } from "./Header.js";
import { Footer } from "./Footer.js";

const EXTRA_CSS = `.nf-body{text-align:center}
.tag{font-size:.76rem;color:var(--faint);letter-spacing:.08em;text-transform:uppercase;margin-bottom:.6rem}
.sub-name{font-family:var(--mono);font-size:clamp(1.1rem,4vw,1.35rem);font-weight:600;color:var(--warn);word-break:break-all;margin-bottom:.5rem;line-height:1.3}
.lead{font-size:.9rem;color:var(--muted);margin:0}`;

const NotFound: FC<{ sub: string }> = ({ sub }) => {
  const claimHref = "https://" + BASE_HOST + "/?n=" + encodeURIComponent(sub);
  return (
    <Layout
      title={sub + " · 还没人占用"}
      extraCss={EXTRA_CSS}
      noindex
    >
      <div class="wrap">
        <Header />
        <div class="card nf-body">
          <div class="tag">404 · 还没人占用</div>
          <div class="sub-name">{sub}.{BASE_HOST}</div>
          <div class="lead">这个子域名空着，想要么？</div>
        </div>
        <a class="promo" href={claimHref}>
          <span class="promo-t">占下 <span style="font-family:var(--mono)">{sub}</span> →</span>
          <span class="promo-s">把文字或链接变成你的 <code>{sub}.{BASE_HOST}</code></span>
          <span class="promo-cta">去创建 →</span>
        </a>
        <Footer />
      </div>
    </Layout>
  );
};

export function notFoundPage(sub: string) {
  return html(renderDoc(<NotFound sub={sub} />), 404);
}
