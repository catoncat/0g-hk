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
//
// D3 (2.12, 2.18): when a Turnstile widget is rendered on this page it injects a
// hidden `cf-turnstile-response` input carrying the solved challenge token, and
// the report has to forward it, because the server now verifies the challenge
// before counting anything.
//
// `tsTok()` is the seam, and it has TWO forms rather than one defensive form,
// for a reason that is not cosmetic: the widget is optional (no
// TURNSTILE_SITEKEY ⇒ no widget ⇒ no such input exists), and emitting the
// selector unconditionally would put the literal `cf-turnstile-response` into
// the page of a deployment that has no widget at all. Anything scanning the page
// for the widget — the preservation harness's `cf-turnstile` marker included —
// would then see one where none was rendered. So the no-key build gets the
// honest constant instead, and there is still exactly ONE report code path.
//
// The reader is defensive even when it is emitted: the widget's script is
// third-party, so the input may be absent, empty, or not yet populated. In each
// of those cases the report is sent with no challenge field and the server
// decides — accepted when TURNSTILE_SECRET is unset, rejected when it is set.
const TS_TOKEN_JS = `function tsTok(){try{var e=document.querySelector('[name="cf-turnstile-response"]');return e&&e.value?e.value:""}catch(_){return ""}}`;
const TS_TOKEN_ABSENT_JS = `function tsTok(){return ""}`;
const REPORT_JS = `function rep(){if(!confirm("确认举报此链接为钓鱼/恶意/欺诈？"))return false;var t=tsTok();fetch("/abuse/report",{method:"POST",headers:{accept:"application/json","content-type":"application/json"},body:JSON.stringify(t?{turnstile:t}:{})}).then(function(r){return r.json()}).then(function(j){alert(j && j.disabled?"举报已提交，链接已被自动禁用。":(j && j.ok?"举报已提交，感谢协助。":"举报未受理，请稍后重试或邮件联系。"))}).catch(function(){alert("网络错误，稍后重试。")});return false}`;

const Interstitial: FC<{ sub: string; target: string; host: string; siteKey?: string }> = ({ target, host, siteKey }) => (
  <Layout
    title={`即将跳转 · ${BASE_HOST}`}
    extraCss={EXTRA_CSS}
    inlineScript={(siteKey ? TS_TOKEN_JS : TS_TOKEN_ABSENT_JS) + "\n" + REPORT_JS}
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
        {siteKey ? (
          <>
            <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
            <div class="cf-turnstile" data-sitekey={siteKey} data-action="abuse-report"></div>
          </>
        ) : null}
      </div>
      <Footer />
    </div>
  </Layout>
);

/**
 * `siteKey` is OPTIONAL and trailing: omitting it renders exactly the page that
 * existed before, which is both what an unconfigured deployment gets and what
 * test/views.test.ts's existing call compiles to. The widget's script, frame and
 * XHR origins are already permitted by SECURITY_HEADERS' CSP
 * (challenges.cloudflare.com appears in script-src, frame-src and connect-src),
 * so no CSP change accompanies this.
 */
export function interstitialPage(sub: string, target: string, siteKey?: string) {
  const parsed = parseUrlSafe(target);
  const host = parsed ? parsed.hostname : target;
  return html(renderDoc(<Interstitial sub={sub} target={target} host={host} siteKey={siteKey} />));
}
