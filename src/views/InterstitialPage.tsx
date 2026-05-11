// Confirm-redirect page shown for URL notes whose target isn't on the
// REDIRECT_ALLOWLIST. Lets users eyeball the host before clicking through,
// and gives them a one-click abuse-report button.
import type { FC } from "hono/jsx";
import { BASE_HOST } from "../constants.js";
import { parseUrlSafe } from "../util.js";
import { html } from "../responses.js";
import { Layout, renderDoc } from "./Layout.js";
import { Header } from "./Header.js";
import { Footer } from "./Footer.js";

const EXTRA_CSS = `.warn-card{max-width:560px;margin-left:auto;margin-right:auto;border-left:3px solid var(--warn)}
.warn-card h2{margin:0 0 .5rem;font-size:1.05rem;font-weight:600}
.warn-lead{font-size:.88rem;color:var(--muted);margin:0 0 1rem;line-height:1.55}
.host{font-family:var(--mono);font-size:1.05rem;font-weight:600;color:var(--warn);word-break:break-all;line-height:1.4;margin:0 0 .75rem}
.target{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;margin:0 0 1.25rem;font-family:var(--mono);font-size:.82rem;word-break:break-all;line-height:1.5;color:var(--text)}
.act{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center}
.act .links{margin-left:auto;font-size:.8rem;color:var(--faint)}
.act .links a{color:inherit;text-decoration:none;cursor:pointer}
@media(hover:hover){.act .links a:hover{color:var(--text)}}`;

// Inline JS for the "举报此链接" link. POSTs to /abuse/report; relies on the
// page being served on the note's subdomain so the server knows which sub to
// flag.
const REPORT_JS = `function rep(){if(!confirm("确认举报此链接为钓鱼/恶意/欺诈？"))return false;fetch("/abuse/report",{method:"POST",headers:{accept:"application/json"}}).then(function(r){return r.json()}).then(function(j){alert(j && j.disabled?"举报已提交，链接已被自动禁用。":"举报已提交，感谢协助。")}).catch(function(){alert("网络错误，稍后重试。")});return false}`;

const Interstitial: FC<{ sub: string; target: string; host: string }> = ({ target, host }) => (
  <Layout
    title={`即将跳转 · ${BASE_HOST}`}
    extraCss={EXTRA_CSS}
    inlineScript={REPORT_JS}
    noindex
  >
    <div class="wrap">
      <Header />
      <div class="card warn-card">
        <h2>即将离开 {BASE_HOST}</h2>
        <p class="warn-lead">此链接由用户创建，不在可信白名单。请先确认目标域名：</p>
        <div class="host">{host}</div>
        <div class="target">{target}</div>
        <div class="act">
          <a class="btn primary" rel="noopener noreferrer nofollow" href={target}>确认继续 →</a>
          <span class="links"><a href="#" onclick="return rep()">举报此链接</a></span>
        </div>
      </div>
      <Footer />
    </div>
  </Layout>
);

export function interstitialPage(sub: string, target: string) {
  const parsed = parseUrlSafe(target);
  const host = parsed ? parsed.hostname : target;
  return html(renderDoc(<Interstitial sub={sub} target={target} host={host} />));
}
