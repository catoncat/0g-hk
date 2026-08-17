// Owner-only note editor. Auth lives in the URL fragment (#t=<edit-token>),
// which browsers never send to any server, so the token reaches this page
// without being logged on the way in.
//
// Keeping it unlogged on the way OUT is what the save path is shaped around
// (D1, 2.1 / 2.6). The page seeds the textarea from GET /raw (no credential at
// all), then saves with POST / — the token in the `X-Edit-Token` request header
// and the content in a JSON body. Nothing secret is ever placed in a URL, so
// hono's logger(), Cloudflare's request logs, `Referer` headers, browser history
// and any intermediate proxy see a bare `POST /`.
//
// This replaced `GET /?edit=<token>&c=<content>`, which wrote the owner's
// credential into every one of those places and mutated state on a GET. That
// query form is still accepted by the server for back-compat (and is redacted in
// logs), but nothing in this page emits it.
import type { FC } from "hono/jsx";
import { BASE_HOST } from "../constants.js";
import { html } from "../responses.js";
import { Layout, renderDoc } from "./Layout.js";
import { Header } from "./Header.js";
import { Footer } from "./Footer.js";

const EXTRA_CSS = `.meta{font-family:var(--mono);font-size:.85rem;color:var(--faint);margin-bottom:1rem}
.meta strong{color:var(--text)}
.edit-row{display:flex;gap:.75rem;align-items:center;margin-top:1.25rem}
.edit-row button{flex:0 0 auto}
.edit-row .status{flex:1;font-size:.85rem;color:var(--faint);min-height:1.2em}
.status.ok{color:var(--ok)}.status.err{color:var(--err)}
.alert-err{background:rgba(176,42,42,.07);border:1px solid rgba(176,42,42,.28);color:var(--err);border-radius:8px;padding:.85rem 1rem;font-size:.9rem;line-height:1.55}
@media(prefers-color-scheme:dark){.alert-err{background:rgba(224,112,112,.08);border-color:rgba(224,112,112,.32)}}`;

const EDIT_JS = `var tm=location.hash.match(/t=([A-Za-z0-9_-]+)/);
var token=tm?tm[1]:"";
var wrap=document.getElementById("wrap"),errBox=document.getElementById("err"),ta=document.getElementById("c"),st=document.getElementById("st"),sb=document.getElementById("s");
function showErr(m){errBox.textContent=m;errBox.style.display=""}
function setStatus(m,cls){st.textContent=m;st.className="status "+(cls||"")}
if(!token){showErr("缺少编辑 token。请使用完整的编辑链接（包含 #t=...）。")}
else{fetch("/raw").then(function(r){if(!r.ok)throw r.status;return r.text()}).then(function(t){ta.value=t;wrap.style.display=""}).catch(function(e){showErr("加载失败："+e+"。笔记可能已过期或不存在。")})}
function save(){var c=ta.value;if(!c){setStatus("内容不能为空","err");return}sb.disabled=true;setStatus("保存中…");fetch("/",{method:"POST",headers:{"content-type":"application/json",accept:"application/json","x-edit-token":token},body:JSON.stringify({content:c})}).then(function(r){sb.disabled=false;if(r.ok){setStatus("已保存 ✓","ok");setTimeout(function(){setStatus("")},2500)}else if(r.status===403){setStatus("保存失败：编辑链接无效","err")}else if(r.status===429){setStatus("保存失败：频率超限，稍后再试","err")}else{setStatus("保存失败："+r.status,"err")}}).catch(function(e){sb.disabled=false;setStatus("网络错误："+e,"err")})}
document.addEventListener("keydown",function(e){if((e.metaKey||e.ctrlKey)&&e.key==="s"){e.preventDefault();save()}});`;

const EditNote: FC<{ sub: string; ttlKey: string }> = ({ sub, ttlKey }) => (
  <Layout
    title={`编辑 ${sub} · ${BASE_HOST}`}
    extraCss={EXTRA_CSS}
    inlineScript={EDIT_JS}
    noindex
  >
    <div class="wrap">
      <Header />
      <div class="card">
        <h1>编辑笔记</h1>
        <div class="meta"><strong>{sub}.{BASE_HOST}</strong> · 保留 {ttlKey}</div>
        <div id="wrap" style="display:none">
          <textarea id="c" autofocus></textarea>
          <div class="edit-row">
            <button id="s" class="btn primary" onclick="save()">保存</button>
            <span id="st" class="status"></span>
          </div>
        </div>
        <div id="err" class="alert-err" style="display:none"></div>
      </div>
      <Footer />
    </div>
  </Layout>
);

export function editNotePage(sub: string, ttlKey: string) {
  // Edit page carries an auth token in the fragment; never cache.
  return html(renderDoc(<EditNote sub={sub} ttlKey={ttlKey} />), 200, { "cache-control": "no-store" });
}
