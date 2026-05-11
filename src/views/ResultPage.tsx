// Post-create / post-edit confirmation. Shows the new short URL, optional
// whitelist warning (for redirect-mode notes whose target isn't allowlisted),
// one-shot "copy edit link" button, and a collapsed details block (QR + raw
// + target preview).
import type { FC } from "hono/jsx";
import { BASE_HOST } from "../constants.js";
import { isUrl, isAllowedTarget, parseUrlSafe } from "../util.js";
import { html } from "../responses.js";
import { Layout, renderDoc } from "./Layout.js";

const EXTRA_CSS = `body{padding-top:clamp(20px,6vw,56px)}
.card{border-radius:20px;box-shadow:0 2px 12px rgba(0,0,0,.028)}
@media(prefers-color-scheme:dark){.card{box-shadow:0 2px 12px rgba(0,0,0,.35)}}
.brand{font-family:var(--mono);font-size:clamp(2rem,7vw,2.6rem);font-weight:800;letter-spacing:-.04em;line-height:1;text-align:center;margin:0 0 .4rem}
.brand .dot{color:#10b981}
.status{text-align:center;color:var(--faint);font-size:.82rem;margin:0 0 1.4rem;letter-spacing:.005em}
.url-card{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:.4rem;align-items:stretch;border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:.4rem .4rem .4rem .85rem;margin-bottom:1.4rem}
.url-card .short-link{display:flex;align-items:center;min-width:0;font-family:var(--mono);font-size:.95rem;color:var(--text);text-decoration:none;word-break:break-all;line-height:1.35;padding:.3rem 0}
@media(hover:hover){.url-card .short-link:hover{opacity:.75}}
.url-card .btn{min-height:36px;padding:0 .9rem;font-size:.85rem;white-space:nowrap}
@media(max-width:520px){.url-card{grid-template-columns:1fr 1fr;padding:.6rem}.url-card .short-link{grid-column:1/-1;padding:.4rem .25rem .35rem}.url-card .btn{justify-content:center}}
.edit-block{margin:0 0 1.4rem;text-align:center}
.edit-block .edit-btn{width:100%;min-height:44px;font-size:.9rem;background:var(--surface)}
.edit-block .edit-hint{display:block;color:var(--faint);font-size:.74rem;margin-top:.5rem}
.wl{display:flex;gap:.5rem;align-items:flex-start;margin:0 0 1.2rem;padding:.6rem .8rem;border-radius:8px;font-size:.8rem;line-height:1.5}
.wl .wl-ic{flex:0 0 auto;font-size:.9rem;line-height:1.4}
.wl code{font-family:var(--mono);background:rgba(128,128,128,.18);padding:.02rem .28rem;border-radius:3px;font-size:.9em}
.wl.wl-warn{background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.22);color:var(--text)}
.wl.wl-warn code{color:var(--warn)}
.more{margin-top:.25rem;border-top:1px solid var(--border);padding-top:.85rem}
.more>summary{cursor:pointer;color:var(--faint);font-size:.8rem;list-style:none;padding:.2rem 0;-webkit-tap-highlight-color:transparent;user-select:none}
.more>summary::-webkit-details-marker{display:none}
.more>summary::before{content:"▸";display:inline-block;margin-right:.4rem;transition:transform .15s;font-size:.85em}
.more[open]>summary::before{transform:rotate(90deg)}
@media(hover:hover){.more>summary:hover{color:var(--text)}}
.more-body{padding-top:.95rem;display:flex;flex-direction:column;gap:.85rem;align-items:center}
.qr{padding:8px;border-radius:10px;background:#fff;border:1px solid var(--border);width:fit-content}
.qr img{display:block;width:160px;height:160px}
.d-row{display:flex;gap:.85rem;font-size:.82rem;width:100%;justify-content:space-between;align-items:baseline}
.d-row .d-k{color:var(--faint);flex:0 0 auto}
.d-row .d-v{color:var(--text);text-decoration:none;border-bottom:1px dotted var(--border-strong);word-break:break-all;text-align:right;min-width:0}
.d-row a.d-v:hover{border-bottom-style:solid}
.mini-foot{text-align:center;color:var(--faint);font-size:.72rem;margin-top:1.5rem}
.mini-foot a{color:inherit;text-decoration:none}
@media(hover:hover){.mini-foot a:hover{color:var(--text)}}`;

const COPY_JS = `function copyFromButton(b){var label=b.getAttribute("data-label")||"复制";navigator.clipboard.writeText(b.getAttribute("data-copy")||"").then(function(){b.textContent="已复制";setTimeout(function(){b.textContent=label},1500)})}`;

const TTL_LABEL: Record<string, string> = { "1h": "1 小时", "1d": "1 天", "7d": "7 天" };

type ResultProps = {
  name: string;
  content: string;
  mode: "created" | "updated";
  ttlKey: string | null;
  editToken: string | null;
};

const Result: FC<ResultProps> = ({ name, content, mode, ttlKey, editToken }) => {
  const short = "https://" + name + "." + BASE_HOST;
  const editUrl = editToken ? short + "/edit#t=" + editToken : null;
  const link = isUrl(content);
  const allowed = link && isAllowedTarget(content);
  const header = mode === "updated" ? "已更新" : "已创建";
  const ttlDisplay = ttlKey ? (TTL_LABEL[ttlKey] || ttlKey) : null;
  const qrSrc =
    "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" +
    encodeURIComponent(short);
  const parsedHost = link ? ((parseUrlSafe(content) || ({} as URL)).hostname || "") : "";
  const trimmed = content.trim();
  const targetLabel = trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed;
  const homeHref = "https://" + BASE_HOST + "/";

  return (
    <Layout
      title={header + " · " + name}
      extraCss={EXTRA_CSS}
      inlineScript={COPY_JS}
    >
      <div class="wrap">
        <div class="card">
          <h1 class="brand">0g<span class="dot">.</span>hk<span class="dot">.</span></h1>
          <div class="status">{header}{ttlDisplay ? " · " + ttlDisplay + "后过期" : ""}</div>
          <div class="url-card">
            <a class="short-link" href={short} target="_blank" rel="noopener noreferrer">{short}</a>
            <button
              type="button"
              class="btn ghost"
              data-copy={short}
              data-label="复制"
              onclick="copyFromButton(this)"
            >复制</button>
            <a class="btn primary" href={short} target="_blank" rel="noopener noreferrer">打开</a>
          </div>
          {link && !allowed ? (
            <div class="wl wl-warn">
              <span class="wl-ic">🛡️</span>
              <span><code>{parsedHost}</code> 不在白名单，访问者会先看到跳转确认页。</span>
            </div>
          ) : null}
          {editUrl ? (
            <div class="edit-block">
              <button
                type="button"
                class="btn ghost edit-btn"
                data-copy={editUrl}
                data-label="🔑 复制编辑链接（仅一次）"
                onclick="copyFromButton(this)"
              >🔑 复制编辑链接（仅一次）</button>
              <small class="edit-hint">关掉就拿不回了</small>
            </div>
          ) : null}
          <details class="more">
            <summary>更多（二维码 / 原文）</summary>
            <div class="more-body">
              <div class="qr"><img alt="QR" src={qrSrc} width="160" height="160" loading="lazy" /></div>
              <div class="d-row">
                <span class="d-k">原文</span>
                <a class="d-v" href={short + "/raw"}>/raw</a>
              </div>
              {link ? (
                <div class="d-row">
                  <span class="d-k">目标</span>
                  <a class="d-v" href={trimmed} rel="noopener">{targetLabel}</a>
                </div>
              ) : (
                <div class="d-row">
                  <span class="d-k">长度</span>
                  <span class="d-v">{content.length} 字符</span>
                </div>
              )}
            </div>
          </details>
        </div>
        <div class="mini-foot"><a href={homeHref}>{BASE_HOST}</a></div>
      </div>
    </Layout>
  );
};

export function resultPage(
  name: string,
  content: string,
  mode: "created" | "updated",
  ttlKey: string | null,
  editToken: string | null,
) {
  return html(renderDoc(
    <Result name={name} content={content} mode={mode} ttlKey={ttlKey} editToken={editToken} />,
  ));
}
