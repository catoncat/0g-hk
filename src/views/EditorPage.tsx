// Home / editor page. Renders the markdown shell, name input with availability
// check, TTL chips, and the publish button. Most of the behavior lives in the
// inline <script> at the bottom; CSS is split between COMMON_CSS (shared via
// Layout) and EXTRA_CSS (home-specific layout).
import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { BASE_HOST, DEFAULT_TTL } from "../constants.js";
import { html } from "../responses.js";
import { Layout, renderDoc } from "./Layout.js";
import { Footer } from "./Footer.js";

// UI exposes a minimal TTL set; API still accepts all TTL_OPTIONS keys.
const UI_TTLS: { key: string; label: string }[] = [
  { key: "1d", label: "1天" },
  { key: "7d", label: "7天" },
];

const EXTRA_CSS = `body{padding:clamp(16px,4vh,40px) 16px 14px;min-height:100svh;display:flex}
.home-wrap{width:100%;display:flex;flex:1;flex-direction:column;min-height:0}
.home-logo{flex:0 0 auto;margin:0 0 1.15rem}
.home-brand{font-family:var(--mono);font-size:clamp(2.35rem,8vw,3.35rem);font-weight:800;letter-spacing:-.04em;line-height:1;display:flex;align-items:baseline;flex-wrap:nowrap;min-width:0;margin:0}
.home-brand .dot{color:#10b981}
.home-brand .tw{color:var(--text);display:inline-block;min-width:.1em}
.home-brand .cursor{display:inline-block;width:.08em;height:.78em;background:#10b981;vertical-align:baseline;margin-left:.05em;animation:tw-blink 1s step-end infinite;border-radius:1px;align-self:center}
@keyframes tw-blink{50%{opacity:0}}
form{flex:1;display:flex;flex-direction:column;min-height:0}
.md-shell{border:1px solid var(--border);border-radius:10px;background:var(--surface);overflow:hidden;transition:border-color .12s,box-shadow .12s;display:flex;flex:1 1 0;flex-direction:column;min-height:16rem}
.md-shell:focus-within{border-color:var(--text);box-shadow:0 0 0 3px rgba(17,17,17,.06)}
@media(prefers-color-scheme:dark){.md-shell:focus-within{box-shadow:0 0 0 3px rgba(237,237,237,.08)}}
.md-bar{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.36rem;background:var(--surface-2);border-bottom:1px solid var(--border)}
.md-tools,.md-modes{display:flex;align-items:center;gap:.25rem;flex-wrap:nowrap}
.md-tools{flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}.md-tools::-webkit-scrollbar{display:none}.md-modes{flex:0 0 auto;margin-left:auto}
.md-btn{display:inline-flex;align-items:center;justify-content:center;width:30px;min-width:30px;height:30px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--muted);font:600 .78rem/1 var(--mono);cursor:pointer;-webkit-tap-highlight-color:transparent}
.md-btn svg{display:block;width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.md-btn.active{background:var(--surface);color:var(--text);box-shadow:inset 0 0 0 1px var(--border)}
@media(hover:hover){.md-btn:hover{background:var(--surface);color:var(--text)}}
.md-shell textarea{display:block;width:100%;flex:1;min-height:0;border:0;border-radius:0;background:transparent;padding:.85rem .95rem;color:inherit;font:400 .92rem/1.65 var(--mono);resize:none;outline:0;overflow:auto}
.md-shell.previewing textarea{display:none}
.md-preview{display:none;flex:1;min-height:0;padding:.85rem .95rem;line-height:1.65;overflow:auto;overflow-wrap:anywhere;color:var(--text)}
.md-shell.previewing .md-preview{display:block}
.md-preview>:first-child{margin-top:0}.md-preview>:last-child{margin-bottom:0}.md-preview p{margin:.55em 0}.md-preview h1,.md-preview h2,.md-preview h3{line-height:1.25;margin:.8em 0 .35em}.md-preview h1{font-size:1.35rem}.md-preview h2{font-size:1.15rem}.md-preview h3{font-size:1rem}.md-preview ul,.md-preview ol{padding-left:1.2rem;margin:.55em 0}.md-preview blockquote{margin:.7em 0;padding-left:.75rem;border-left:3px solid var(--border-strong);color:var(--muted)}.md-preview code{font-family:var(--mono);font-size:.9em;background:rgba(128,128,128,.14);border:1px solid var(--border);border-radius:4px;padding:.04rem .24rem}.md-preview pre{margin:.7em 0;padding:.75rem .85rem;background:var(--surface-2);border:1px solid var(--border);border-radius:7px;overflow:auto}.md-preview hr{border:0;border-top:1px solid var(--border);margin:1rem 0}.md-preview .empty{color:var(--faint)}
.publish-row{display:flex;align-items:stretch;min-width:0;margin-top:1rem}
.name-wrap{display:flex;align-items:stretch;border:1px solid var(--border);border-radius:8px;background:var(--surface);overflow:hidden;min-width:0;min-height:44px;margin-top:0}
.publish-row .name-wrap{flex:1;border-right:0;border-radius:8px 0 0 8px}
.name-wrap:focus-within{border-color:var(--text);box-shadow:0 0 0 3px rgba(17,17,17,.06)}
@media(prefers-color-scheme:dark){.name-wrap:focus-within{box-shadow:0 0 0 3px rgba(237,237,237,.08)}}
.name-wrap input{flex:1;min-width:0;border:0;background:transparent;padding:0 .85rem;font:inherit;font-size:1rem;color:inherit;outline:0;min-height:unset}
.name-wrap .suffix{font-family:var(--mono);color:var(--faint);font-size:.9rem;display:flex;align-items:center;padding:0 .85rem 0 0;white-space:nowrap;flex-shrink:0;user-select:none}
.name-wrap.err{border-color:var(--err)}
.name-status{display:block;min-height:1.1em;margin-top:.4rem;font-size:.76rem;color:var(--faint);line-height:1.4}
.name-status.ok{color:var(--ok)}.name-status.warn{color:var(--warn)}.name-status.err{color:var(--err)}.name-status.pending{color:var(--faint)}
.alert-warn{margin:0 0 1rem;padding:.8rem .95rem;border-radius:10px;background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn-fg);font-size:.82rem;line-height:1.55}
.ttl-row{display:flex;gap:.4rem;align-items:center;font-size:.78rem;color:var(--muted);flex-wrap:wrap;margin-top:.7rem}
.chip{position:relative;cursor:pointer;-webkit-tap-highlight-color:transparent}
.chip input{position:absolute;opacity:0;pointer-events:none}
.chip span{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 .85rem;border:1px solid var(--border);border-radius:999px;font-size:.82rem;color:var(--muted);transition:all .12s;user-select:none;background:transparent}
@media(hover:hover){.chip:hover span{border-color:var(--muted);color:var(--text)}}
.chip input:checked+span{background:var(--text);color:var(--bg);border-color:var(--text)}
.chip input:focus-visible+span{outline:2px solid var(--text);outline-offset:2px}
.submit-btn{min-height:44px;min-width:5.2rem;padding:0 1.15rem;border:1px solid var(--text);border-radius:8px;background:var(--text);color:var(--bg);font-family:inherit;font-size:.95rem;font-weight:600;line-height:1;white-space:nowrap;flex-shrink:0;cursor:pointer;transition:filter .12s,transform .12s}
.publish-row .submit-btn{border-radius:0 8px 8px 0}
@media(hover:hover){.submit-btn:hover{filter:brightness(.92)}}
.submit-btn:active{filter:brightness(.86);transform:translateY(0)}.submit-btn:focus-visible{outline:2px solid var(--text);outline-offset:2px}
@media(max-width:560px){body{padding:12px 10px}.home-logo{margin-bottom:.9rem}.home-brand{font-size:clamp(2rem,11vw,2.7rem)}.md-shell{min-height:14rem}.submit-btn{min-width:4.7rem;padding:0 .95rem}.name-wrap input{padding:0 .7rem}.name-wrap .suffix{padding-right:.7rem}}`;

const EDITOR_JS = `var nInp=document.getElementById("n"),nw=document.getElementById("nw"),ns=document.getElementById("ns"),submitBtn=document.getElementById("submitBtn"),ta=document.getElementById("c"),mdShell=document.getElementById("mdShell"),mdPreview=document.getElementById("mdPreview"),previewToggle=document.getElementById("previewToggle");
var checkTimer=null,nameAvailable=null;
function setErr(on){if(on)nw.classList.add("err");else nw.classList.remove("err")}
function setStatus(msg,cls){ns.textContent=msg;ns.className="name-status "+(cls||"")}
function normalizeNameInput(v){return v.replace(/[_\\s]+/g,"-").toLowerCase()}
function nameStatusForReason(d){if(d.reason==="reserved")return{msg:"不可用：系统保留名",cls:"err"};if(d.reason==="brand")return{msg:"不可用：包含保留品牌词 “"+(d.term||"高风险词")+"”",cls:"err"};if(d.reason==="invalid")return{msg:"格式：小写字母/数字/-",cls:"err"};return{msg:"不可用",cls:"err"}}
function escMd(s){return String(s||"").replace(/[&<>"]/g,function(c){if(c==="&")return"&amp;";if(c==="<")return"&lt;";if(c===">")return"&gt;";return"&quot;"})}
function inlineMd(s){return escMd(s).replace(/\`([^\`]+)\`/g,"<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>").replace(/(^|[^*])\\*([^*]+)\\*/g,"$1<em>$2</em>").replace(/~~([^~]+)~~/g,"<del>$1</del>")}
function renderLiteMd(src){var lines=String(src||"").replace(/\\r\\n?/g,"\\n").split("\\n"),out=[],list="";function endList(){if(list){out.push("</"+list+">");list=""}}lines.forEach(function(line){var t=line.trim();if(!t){endList();return}var h=t.match(/^(#{1,3})\\s+(.+)$/);if(h){endList();out.push("<h"+h[1].length+">"+inlineMd(h[2])+"</h"+h[1].length+">");return}var li=t.match(/^[-*+]\\s+(.+)$/);if(li){if(list!=="ul"){endList();out.push("<ul>");list="ul"}out.push("<li>"+inlineMd(li[1])+"</li>");return}var q=t.match(/^>\\s?(.*)$/);if(q){endList();out.push("<blockquote>"+inlineMd(q[1])+"</blockquote>");return}if(/^[-*_]{3,}$/.test(t)){endList();out.push("<hr>");return}endList();out.push("<p>"+inlineMd(t)+"</p>")});endList();return out.join("")||'<p class="empty">空白</p>'}
function renderPreview(){mdPreview.innerHTML=renderLiteMd(ta.value)}
var previewIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/></svg>',editIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
function setPreviewButton(preview){previewToggle.innerHTML=preview?editIcon:previewIcon;previewToggle.setAttribute("aria-label",preview?"编辑":"预览")}
function setMdMode(preview){mdShell.classList.toggle("previewing",preview);previewToggle.classList.toggle("active",preview);setPreviewButton(preview);if(preview)renderPreview();else ta.focus()}
function surround(a,b,f){var s=ta.selectionStart,e=ta.selectionEnd,v=ta.value,x=v.slice(s,e)||f;ta.setRangeText(a+x+b,s,e,"select");ta.selectionStart=s+a.length;ta.selectionEnd=s+a.length+x.length}
function prefixLine(p,f){var s=ta.selectionStart,e=ta.selectionEnd,v=ta.value;if(s===e){var ls=v.lastIndexOf("\\n",s-1)+1;ta.setRangeText(p+f,ls,s,"end");ta.selectionStart=ls+p.length;ta.selectionEnd=ls+p.length+f.length;return}var x=v.slice(s,e).split("\\n").map(function(l){return p+l}).join("\\n");ta.setRangeText(x,s,e,"select")}
function mdAction(k){setMdMode(false);if(k==="h")prefixLine("# ","标题");else if(k==="b")surround("**","**","加粗");else if(k==="i")surround("*","*","斜体");else if(k==="link")surround("[","](https://)","链接");else if(k==="list")prefixLine("- ","列表项");else if(k==="code")surround("\`","\`","code");ta.focus();renderPreview()}
document.querySelectorAll("[data-md]").forEach(function(b){b.addEventListener("click",function(){mdAction(b.getAttribute("data-md"))})});
previewToggle.addEventListener("click",function(){setMdMode(!mdShell.classList.contains("previewing"))});
var demos=["go","hi","md","up","to","ok"],di=0;
function cyclePh(){if(document.activeElement===nInp||nInp.value)return;nInp.placeholder=demos[di=(di+1)%demos.length]}
setInterval(cyclePh,2200);cyclePh();
var twEl=document.getElementById("tw"),twI=0,twC=demos[0].length,twDel=true;
function tw(){var w=demos[twI];if(twDel){twEl.textContent=w.substring(0,--twC);if(twC===0){twDel=false;twI=(twI+1)%demos.length;setTimeout(tw,500);return}}else{twEl.textContent=w.substring(0,++twC);if(twC===w.length){twDel=true;setTimeout(tw,1800);return}}setTimeout(tw,twDel?55:105)}
setTimeout(tw,1500);
ta.addEventListener("input",function(){if(mdShell.classList.contains("previewing"))renderPreview()});
function checkName(){var v=normalizeNameInput(nInp.value);nInp.value=v;if(!v){setStatus("","");setErr(false);nameAvailable=null;return}if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(v)){setStatus("格式：小写字母/数字/-","err");setErr(true);nameAvailable=false;return}setStatus("检查中…","pending");fetch("/exists?n="+encodeURIComponent(v)).then(function(r){return r.json()}).then(function(d){if(normalizeNameInput(nInp.value)!==v)return;if(!d.valid){var s=nameStatusForReason(d);setStatus(s.msg,s.cls);setErr(true);nameAvailable=false}else if(d.exists){setStatus("已被占用（本人创建请用编辑链接）","warn");setErr(false);nameAvailable=false}else{setStatus("✓ 可用","ok");setErr(false);nameAvailable=true}}).catch(function(){setStatus("","")})}
nInp.addEventListener("input",function(){clearTimeout(checkTimer);checkTimer=setTimeout(checkName,500)});
if(nInp.value)checkName();
function getTtl(){var r=document.querySelector('input[name="ttl"]:checked');return r?r.value:"${DEFAULT_TTL}"}
function go(e){e.preventDefault();var nameVal=normalizeNameInput(nInp.value);nInp.value=nameVal;if(nameVal&&nameAvailable===false){setErr(true);nInp.focus();return false}var c=ta.value;var t=getTtl();var p=new URLSearchParams();if(nameVal)p.set("n",nameVal);p.set("c",c);if(t&&t!=="${DEFAULT_TTL}")p.set("ttl",t);location.href="/?"+p.toString();return false}`;

// SVG icons for the markdown toolbar. Inlined verbatim via raw() so they
// don't get HTML-escaped by hono/jsx.
const MD_BTN_SVGS = {
  h: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M18 5v14M6 12h12"/></svg>`,
  b: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h6a4 4 0 0 1 0 8H7zM7 13h7a3.5 3.5 0 0 1 0 7H7zM7 5v15"/></svg>`,
  i: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5h8M6 19h8M14 5l-4 14"/></svg>`,
  link: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l1.4-1.4a5 5 0 0 0-7.1-7.1l-.8.8M14 11a5 5 0 0 0-7.1 0l-1.4 1.4a5 5 0 0 0 7.1 7.1l.8-.8"/></svg>`,
  list: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
  code: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></svg>`,
  preview: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/></svg>`,
};

const THEME_META = (
  <>
    <meta name="theme-color" content="#fafafa" media="(prefers-color-scheme:light)" />
    <meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme:dark)" />
    <meta name="description" content="把一段文字或链接变成 xxx.0g.hk。无账号、一次 GET 完成。" />
  </>
);

type EditorOpts = {
  prefillContent?: string;
  prefillName?: string;
  prefillTtl?: string;
  errorName?: string;
  alertTop?: string;
};

const Editor: FC<{ opts: EditorOpts }> = ({ opts }) => {
  const prefillContent = opts.prefillContent || "";
  const prefillName = opts.prefillName || "";
  const prefillTtl = opts.prefillTtl || DEFAULT_TTL;
  const errorName = opts.errorName || "";
  const alertTop = opts.alertTop || "";
  const ttlSelected = UI_TTLS.some((o) => o.key === prefillTtl) ? prefillTtl : DEFAULT_TTL;
  return (
    <Layout
      title={`${BASE_HOST} — 临时笔记 · 短链`}
      extraCss={EXTRA_CSS}
      inlineScript={EDITOR_JS}
      headExtras={THEME_META}
      fullViewport
    >
      <div class="wrap home-wrap">
        <header class="home-logo">
          <h1 class="home-brand">
            <span id="tw" class="tw">go</span>
            <span class="cursor"></span>
            <span class="dot">.</span>0g<span class="dot">.</span>hk
          </h1>
        </header>
        {alertTop ? <div class="alert-warn">{alertTop}</div> : null}
        <form onsubmit="return go(event)">
          <div class="md-shell" id="mdShell">
            <div class="md-bar">
              <div class="md-tools" aria-label="Markdown 工具">
                <button type="button" class="md-btn" data-md="h" aria-label="标题">{raw(MD_BTN_SVGS.h)}</button>
                <button type="button" class="md-btn" data-md="b" aria-label="加粗">{raw(MD_BTN_SVGS.b)}</button>
                <button type="button" class="md-btn" data-md="i" aria-label="斜体">{raw(MD_BTN_SVGS.i)}</button>
                <button type="button" class="md-btn" data-md="link" aria-label="链接">{raw(MD_BTN_SVGS.link)}</button>
                <button type="button" class="md-btn" data-md="list" aria-label="列表">{raw(MD_BTN_SVGS.list)}</button>
                <button type="button" class="md-btn" data-md="code" aria-label="代码">{raw(MD_BTN_SVGS.code)}</button>
              </div>
              <div class="md-modes">
                <button type="button" class="md-btn" id="previewToggle" aria-label="预览">{raw(MD_BTN_SVGS.preview)}</button>
              </div>
            </div>
            <textarea id="c" required autofocus rows={5} placeholder="写 Markdown，或粘贴链接" aria-label="内容">{prefillContent}</textarea>
            <div class="md-preview" id="mdPreview" aria-live="polite"></div>
          </div>
          <div class="publish-row">
            <div class={`name-wrap${errorName ? " err" : ""}`} id="nw">
              <input
                id="n"
                value={prefillName}
                autocomplete="off"
                inputmode="url"
                pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
                placeholder="go"
                aria-label="自定义子域名"
              />
              <span class="suffix">.{BASE_HOST}</span>
            </div>
            <button type="submit" id="submitBtn" class="submit-btn">发布</button>
          </div>
          <span id="ns" class={`name-status${errorName ? " err" : ""}`}>{errorName}</span>
          <div class="ttl-row" aria-label="保留时间">
            {UI_TTLS.map((o) => (
              <label class="chip">
                <input type="radio" name="ttl" value={o.key} checked={o.key === ttlSelected} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        </form>
        <Footer />
      </div>
    </Layout>
  );
};

export function editorPage(opts?: EditorOpts) {
  return html(renderDoc(<Editor opts={opts || {}} />));
}
