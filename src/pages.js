// Page renderers (editor, result, note, interstitial, editNote, notFound).
// Extracted verbatim from src/index.js.
import { BASE_HOST, TTL_OPTIONS, DEFAULT_TTL, ABUSE_EMAIL } from "./constants.js";
import { esc, shortUrlFor, isUrl, parseUrlSafe, isAllowedTarget } from "./util.js";
import { renderMarkdown } from "./markdown.js";
import { COMMON_CSS, html, footerHtml, headerHtml, promoCardHtml } from "./responses.js";

const ICON_CLIPBOARD = '<svg class="s-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6"/><path d="M9 4a3 3 0 0 1 6 0"/><path d="M8 6h8"/><path d="M7 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1"/><path d="M8 12h8"/><path d="M8 16h5"/></svg>';
const ICON_LINK = '<svg class="s-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/></svg>';
const ICON_SPARKLES = '<svg class="s-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3Z"/><path d="M19 14l.7 2.1L22 17l-2.3.9L19 20l-.7-2.1L16 17l2.3-.9L19 14Z"/><path d="M5 14l.7 2.1L8 17l-2.3.9L5 20l-.7-2.1L2 17l2.3-.9L5 14Z"/></svg>';

export function editorPage(opts) {
  opts = opts || {};
  const prefillContent = opts.prefillContent || "";
  const prefillName = opts.prefillName || "";
  const prefillTtl = opts.prefillTtl || DEFAULT_TTL;
  const errorName = opts.errorName || "";
  const alertTop = opts.alertTop || "";
  // UI exposes a minimal TTL set; API still accepts all TTL_OPTIONS keys.
  const UI_TTLS = [
    { key: '1d', label: '1天' },
    { key: '7d', label: '7天' },
  ];
  const ttlSelected = UI_TTLS.some((o) => o.key === prefillTtl) ? prefillTtl : DEFAULT_TTL;
  const ttlChips = UI_TTLS.map((o) =>
    '<label class="chip"><input type="radio" name="ttl" value="' + o.key + '"' +
    (o.key === ttlSelected ? ' checked' : '') + '><span>' + o.label + '</span></label>'
  ).join('');

  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
'<meta name="theme-color" content="#fafafa" media="(prefers-color-scheme:light)">' +
'<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme:dark)">' +
'<meta name="description" content="把一段文字或链接变成 xxx.0g.hk。无账号、一次 GET 完成。">' +
'<title>' + BASE_HOST + ' — 临时笔记 · 短链</title>\n' +
'<style>\n' + COMMON_CSS + '\n' +
// Brand wordmark.
'.brand{font-family:var(--mono);font-size:clamp(2.2rem,8vw,3rem);font-weight:800;letter-spacing:-.04em;margin-bottom:.5rem;line-height:1;display:flex;align-items:baseline;flex-wrap:nowrap;min-width:0}\n' +
'.brand .dot{color:#10b981}\n' +
'.brand .tw{color:var(--text);display:inline-block;min-width:.1em}\n' +
'.brand .cursor{display:inline-block;width:.08em;height:.78em;background:#10b981;vertical-align:baseline;margin-left:.05em;animation:tw-blink 1s step-end infinite;border-radius:1px;align-self:center}\n' +
'@keyframes tw-blink{50%{opacity:0}}\n' +
'.card{border-radius:20px;box-shadow:0 2px 12px rgba(0,0,0,.028)}\n' +
'@media(prefers-color-scheme:dark){.card{box-shadow:0 2px 12px rgba(0,0,0,.35)}}\n' +
'body{padding-top:clamp(20px,6vw,56px)}\n' +

// Tagline: allow inline code chip to stay on same line as verb via nowrap wrapper.
'.tagline{color:var(--muted);font-size:clamp(1rem,2.8vw,1.1rem);line-height:1.55;margin-bottom:1.5rem;max-width:34ch}\n' +
'.tagline .kw{color:var(--text);font-family:var(--mono);font-size:.92em;font-weight:500;white-space:nowrap;background:none;padding:0}\n' +
'.tagline .kw .dot{color:#10b981}\n' +
// Lightweight Markdown editor.
'.md-shell{border:1px solid var(--border);border-radius:10px;background:var(--surface);overflow:hidden;transition:border-color .12s,box-shadow .12s}\n' +
'.md-shell:focus-within{border-color:var(--text);box-shadow:0 0 0 3px rgba(17,17,17,.06)}\n' +
'@media(prefers-color-scheme:dark){.md-shell:focus-within{box-shadow:0 0 0 3px rgba(237,237,237,.08)}}\n' +
'.md-bar{display:flex;justify-content:space-between;gap:.5rem;padding:.36rem;background:var(--surface-2);border-bottom:1px solid var(--border)}\n' +
'.md-tools,.md-modes{display:flex;align-items:center;gap:.25rem;flex-wrap:wrap}\n' +
'.md-btn{display:inline-flex;align-items:center;justify-content:center;min-width:30px;min-height:30px;padding:0 .5rem;border:0;border-radius:6px;background:transparent;color:var(--muted);font:600 .78rem/1 var(--mono);cursor:pointer;-webkit-tap-highlight-color:transparent}\n' +
'.md-btn.active{background:var(--surface);color:var(--text);box-shadow:inset 0 0 0 1px var(--border)}\n' +
'@media(hover:hover){.md-btn:hover{background:var(--surface);color:var(--text)}}\n' +
'.md-shell textarea{display:block;width:100%;min-height:7rem;border:0;border-radius:0;background:transparent;padding:.85rem .95rem;color:inherit;font:400 .92rem/1.65 var(--mono);resize:vertical;outline:0}\n' +
'.md-shell.previewing textarea{display:none}\n' +
'.md-preview{display:none;min-height:7rem;padding:.85rem .95rem;line-height:1.65;overflow-wrap:anywhere;color:var(--text)}\n' +
'.md-shell.previewing .md-preview{display:block}\n' +
'.md-preview>:first-child{margin-top:0}.md-preview>:last-child{margin-bottom:0}.md-preview p{margin:.55em 0}.md-preview h1,.md-preview h2,.md-preview h3{line-height:1.25;margin:.8em 0 .35em}.md-preview h1{font-size:1.35rem}.md-preview h2{font-size:1.15rem}.md-preview h3{font-size:1rem}.md-preview ul,.md-preview ol{padding-left:1.2rem;margin:.55em 0}.md-preview blockquote{margin:.7em 0;padding-left:.75rem;border-left:3px solid var(--border-strong);color:var(--muted)}.md-preview code{font-family:var(--mono);font-size:.9em;background:rgba(128,128,128,.14);border:1px solid var(--border);border-radius:4px;padding:.04rem .24rem}.md-preview pre{margin:.7em 0;padding:.75rem .85rem;background:var(--surface-2);border:1px solid var(--border);border-radius:7px;overflow:auto}.md-preview hr{border:0;border-top:1px solid var(--border);margin:1rem 0}.md-preview .empty{color:var(--faint)}\n' +
// Field caption (small muted label above each control).
'.cap{font-size:.76rem;color:var(--faint);margin:1rem 0 .4rem;display:flex;justify-content:space-between;align-items:baseline;gap:.5rem}\n' +
'.cap .hint-r{color:var(--faint);font-size:.72rem}\n' +
// Name field (full-width, with inline .0g.hk suffix).
'.name-wrap{display:flex;align-items:stretch;border:1px solid var(--border);border-radius:8px;background:var(--surface);overflow:hidden;min-width:0;min-height:44px}\n' +
'.name-wrap:focus-within{border-color:var(--text);box-shadow:0 0 0 3px rgba(17,17,17,.06)}\n' +
'@media(prefers-color-scheme:dark){.name-wrap:focus-within{box-shadow:0 0 0 3px rgba(237,237,237,.08)}}\n' +
'.name-wrap input{flex:1;min-width:0;border:0;background:transparent;padding:0 .85rem;font:inherit;font-size:1rem;color:inherit;outline:0;min-height:unset}\n' +
'.name-wrap .suffix{font-family:var(--mono);color:var(--faint);font-size:.9rem;display:flex;align-items:center;padding:0 .85rem 0 0;white-space:nowrap;flex-shrink:0;user-select:none}\n' +
'.name-wrap.err{border-color:var(--err)}\n' +
// Status line beneath name (availability check).
'.name-status{display:block;min-height:1.1em;margin-top:.4rem;font-size:.76rem;color:var(--faint);line-height:1.4}\n' +
'.name-status.ok{color:var(--ok)}.name-status.warn{color:var(--warn)}.name-status.err{color:var(--err)}.name-status.pending{color:var(--faint)}\n' +
'.alert-warn{margin:0 0 1rem;padding:.8rem .95rem;border-radius:10px;background:var(--warn-bg);border:1px solid var(--warn-border);color:var(--warn-fg);font-size:.82rem;line-height:1.55}\n' +
// Action row: TTL chips (left) + submit button (right). Wraps on narrow screens.
'.action{display:flex;gap:.6rem .85rem;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:1rem}\n' +
'.ttl-row{display:flex;gap:.4rem;align-items:center;font-size:.78rem;color:var(--muted);flex-wrap:wrap}\n' +
'.ttl-row .lbl{color:var(--faint);margin-right:.25rem}\n' +
'.chip{position:relative;cursor:pointer;-webkit-tap-highlight-color:transparent}\n' +
'.chip input{position:absolute;opacity:0;pointer-events:none}\n' +
'.chip span{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 .85rem;border:1px solid var(--border);border-radius:999px;font-size:.82rem;color:var(--muted);transition:all .12s;user-select:none;background:transparent}\n' +
'@media(hover:hover){.chip:hover span{border-color:var(--muted);color:var(--text)}}\n' +
'.chip input:checked+span{background:var(--text);color:var(--bg);border-color:var(--text)}\n' +
'.chip input:focus-visible+span{outline:2px solid var(--text);outline-offset:2px}\n' +
// Primary submit button.
'.action button{min-height:44px;padding:0 1.25rem;font-size:.95rem;white-space:nowrap;flex-shrink:0}\n' +
'.type-hint{font-size:.72rem;color:var(--faint);font-family:var(--mono);margin-top:.55rem;min-height:1.1em;text-align:right;letter-spacing:.01em}\n' +
// Scenario accordion.
'.scn{display:flex;flex-direction:column;gap:.55rem;margin-top:1.25rem}\n' +
'.s-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;line-height:1.5;min-width:0;overflow:hidden}\n' +
'.s-head{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:.55rem;align-items:center;padding:.72rem .9rem;cursor:pointer;list-style:none;-webkit-tap-highlight-color:transparent}\n' +
'.s-head::-webkit-details-marker{display:none}\n' +
'.s-icon{width:1rem;height:1rem;flex:0 0 1rem;color:var(--muted);stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}\n' +
'.s-title{font-weight:600;color:var(--text);font-size:.9rem}\n' +
'.s-desc{color:var(--muted);font-size:.8rem;line-height:1.5;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n' +
'.s-chev{color:var(--faint);font-size:.9rem;transition:transform .15s}\n' +
'.s-card[open] .s-chev{transform:rotate(90deg)}\n' +
'.s-body{padding:0 .9rem .9rem;display:grid;gap:.65rem}\n' +
'.s-card pre{font-family:var(--mono);font-size:.78rem;background:rgba(128,128,128,.08);padding:.7rem .75rem;border-radius:7px;color:var(--text);overflow-x:auto;white-space:pre-wrap;line-height:1.55;margin:0;-webkit-overflow-scrolling:touch}\n' +
'.s-card pre::-webkit-scrollbar{height:0}\n' +
'.s-action{justify-self:start;min-height:32px;padding:0 .75rem;border:1px solid var(--border-strong);border-radius:7px;background:transparent;color:var(--text);font:inherit;font-size:.8rem;cursor:pointer}\n' +
'@media(hover:hover){.s-action:hover{background:var(--surface-2)}}\n' +
'@media(max-width:560px){.md-bar{align-items:flex-start;flex-direction:column}.s-head{grid-template-columns:auto minmax(0,1fr) auto}.s-desc{display:none}}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
'<div class="card">\n' +
'<h1 class="brand"><span id="tw" class="tw">demo</span><span class="cursor"></span><span class="dot">.</span>0g<span class="dot">.</span>hk</h1>\n' +
'<div class="tagline">把想说的，一秒变成一条链接。</div>\n' +
(alertTop ? '<div class="alert-warn">' + alertTop + '</div>\n' : '') +
'<form onsubmit="return go(event)">\n' +
'<label for="c" class="sr">内容</label>' +
'<div class="md-shell" id="mdShell">\n' +
'<div class="md-bar"><div class="md-tools" aria-label="Markdown 工具">\n' +
'<button type="button" class="md-btn" data-md="h" aria-label="标题">H</button><button type="button" class="md-btn" data-md="b" aria-label="加粗">B</button><button type="button" class="md-btn" data-md="i" aria-label="斜体"><em>I</em></button><button type="button" class="md-btn" data-md="link" aria-label="链接">[]</button><button type="button" class="md-btn" data-md="list" aria-label="列表">•</button><button type="button" class="md-btn" data-md="code" aria-label="代码">{}</button>\n' +
'</div><div class="md-modes"><button type="button" class="md-btn active" id="writeMode">写</button><button type="button" class="md-btn" id="previewMode">预览</button></div></div>\n' +
'<textarea id="c" required autofocus rows="5" placeholder="写 Markdown，或粘贴链接">' + esc(prefillContent) + '</textarea>\n' +
'<div class="md-preview" id="mdPreview" aria-live="polite"></div>\n' +
'</div>\n' +
'<div class="type-hint" id="typeHint"></div>\n' +
'<div class="cap"><span>子域名字</span><span class="hint-r">留空 = 随机分配</span></div>\n' +
'<div class="name-wrap' + (errorName ? ' err' : '') + '" id="nw"><input id="n" value="' + esc(prefillName) + '" autocomplete="off" inputmode="url" pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" placeholder="talk" aria-label="自定义子域名"><span class="suffix">.' + BASE_HOST + '</span></div>' +
'<span id="ns" class="name-status' + (errorName ? ' err' : '') + '">' + esc(errorName) + '</span>\n' +
'<div class="action"><div class="ttl-row"><span class="lbl">保留</span>' + ttlChips + '</div>' +
'<button type="submit" id="submitBtn">生成 →</button></div>\n' +
'</form>\n' +
'</div>\n' +
'<section class="scn" aria-label="用法">\n' +
'<details class="s-card" open><summary class="s-head">' + ICON_CLIPBOARD + '<span class="s-title">写笔记</span><span class="s-desc">Markdown / 清单 / 代码</span><span class="s-chev">›</span></summary><div class="s-body"><pre>## 今天要做\n- 约时间\n- 发链接\n- 留个备注</pre><button type="button" class="s-action" data-sample="note">填入编辑器</button></div></details>\n' +
'<details class="s-card"><summary class="s-head">' + ICON_LINK + '<span class="s-title">缩短链接</span><span class="s-desc">粘贴 URL</span><span class="s-chev">›</span></summary><div class="s-body"><pre>https://chen.rs</pre><button type="button" class="s-action" data-sample="link">填入编辑器</button></div></details>\n' +
'<details class="s-card"><summary class="s-head">' + ICON_SPARKLES + '<span class="s-title">保存 Prompt</span><span class="s-desc">给 AI 的上下文</span><span class="s-chev">›</span></summary><div class="s-body"><pre>把下面内容整理成三点摘要：</pre><button type="button" class="s-action" data-sample="prompt">填入编辑器</button></div></details>\n' +
'</section>\n' +
 footerHtml() + '\n' +
'</div>\n' +
'<script>\n' +
'var nInp=document.getElementById("n"),nw=document.getElementById("nw"),ns=document.getElementById("ns"),submitBtn=document.getElementById("submitBtn"),ta=document.getElementById("c"),th=document.getElementById("typeHint"),mdShell=document.getElementById("mdShell"),mdPreview=document.getElementById("mdPreview"),writeMode=document.getElementById("writeMode"),previewMode=document.getElementById("previewMode");\n' +
'var checkTimer=null,nameAvailable=null;\n' +
'function setErr(on){if(on)nw.classList.add("err");else nw.classList.remove("err")}\n' +
'function setStatus(msg,cls){ns.textContent=msg;ns.className="name-status "+(cls||"")}\n' +
'function normalizeNameInput(v){return v.replace(/[_\\s]+/g,"-").toLowerCase()}\n' +
'function nameStatusForReason(d){if(d.reason==="reserved")return{msg:"不可用：系统保留名",cls:"err"};if(d.reason==="brand")return{msg:"不可用：包含保留品牌词 “"+(d.term||"高风险词")+"”",cls:"err"};if(d.reason==="invalid")return{msg:"格式：小写字母/数字/-",cls:"err"};return{msg:"不可用",cls:"err"}}\n' +
'function escMd(s){return String(s||"").replace(/[&<>"]/g,function(c){if(c==="&")return"&amp;";if(c==="<")return"&lt;";if(c===">")return"&gt;";return"&quot;"})}\n' +
'function inlineMd(s){return escMd(s).replace(/`([^`]+)`/g,"<code>$1</code>").replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>").replace(/(^|[^*])\\*([^*]+)\\*/g,"$1<em>$2</em>").replace(/~~([^~]+)~~/g,"<del>$1</del>")}\n' +
'function renderLiteMd(src){var lines=String(src||"").replace(/\\r\\n?/g,"\\n").split("\\n"),out=[],list="";function endList(){if(list){out.push("</"+list+">");list=""}}lines.forEach(function(line){var t=line.trim();if(!t){endList();return}var h=t.match(/^(#{1,3})\\s+(.+)$/);if(h){endList();out.push("<h"+h[1].length+">"+inlineMd(h[2])+"</h"+h[1].length+">");return}var li=t.match(/^[-*+]\\s+(.+)$/);if(li){if(list!=="ul"){endList();out.push("<ul>");list="ul"}out.push("<li>"+inlineMd(li[1])+"</li>");return}var q=t.match(/^>\\s?(.*)$/);if(q){endList();out.push("<blockquote>"+inlineMd(q[1])+"</blockquote>");return}if(/^[-*_]{3,}$/.test(t)){endList();out.push("<hr>");return}endList();out.push("<p>"+inlineMd(t)+"</p>")});endList();return out.join("")||"<p class=\\"empty\\">空白</p>"}\n' +
'function renderPreview(){mdPreview.innerHTML=renderLiteMd(ta.value)}\n' +
'function setMdMode(preview){mdShell.classList.toggle("previewing",preview);writeMode.classList.toggle("active",!preview);previewMode.classList.toggle("active",preview);if(preview)renderPreview();else ta.focus()}\n' +
'function surround(a,b,f){var s=ta.selectionStart,e=ta.selectionEnd,v=ta.value,x=v.slice(s,e)||f;ta.setRangeText(a+x+b,s,e,"select");ta.selectionStart=s+a.length;ta.selectionEnd=s+a.length+x.length}\n' +
'function prefixLine(p,f){var s=ta.selectionStart,e=ta.selectionEnd,v=ta.value;if(s===e){var ls=v.lastIndexOf("\\n",s-1)+1;ta.setRangeText(p+f,ls,s,"end");ta.selectionStart=ls+p.length;ta.selectionEnd=ls+p.length+f.length;return}var x=v.slice(s,e).split("\\n").map(function(l){return p+l}).join("\\n");ta.setRangeText(x,s,e,"select")}\n' +
'function mdAction(k){setMdMode(false);if(k==="h")prefixLine("# ","标题");else if(k==="b")surround("**","**","加粗");else if(k==="i")surround("*","*","斜体");else if(k==="link")surround("[","](https://)","链接");else if(k==="list")prefixLine("- ","列表项");else if(k==="code")surround("`","`","code");ta.focus();updateCta();renderPreview()}\n' +
'document.querySelectorAll("[data-md]").forEach(function(b){b.addEventListener("click",function(){mdAction(b.getAttribute("data-md"))})});\n' +
'writeMode.addEventListener("click",function(){setMdMode(false)});previewMode.addEventListener("click",function(){setMdMode(true)});\n' +
'document.querySelectorAll(".s-card").forEach(function(d){d.addEventListener("toggle",function(){if(!d.open)return;document.querySelectorAll(".s-card").forEach(function(o){if(o!==d)o.open=false})})});\n' +
'var samples={note:"## 今天要做\\n- 约时间\\n- 发链接\\n- 留个备注",link:"https://chen.rs",prompt:"把下面内容整理成三点摘要：\\n\\n"};\n' +
'document.querySelectorAll("[data-sample]").forEach(function(b){b.addEventListener("click",function(){var v=samples[b.getAttribute("data-sample")]||"";ta.value=v;setMdMode(false);updateCta();renderPreview();ta.focus()})});\n' +
// Rotating placeholder hints that name is customizable.
'var demos=["talk","q3-plan","read-me","demo","party","notes"],di=0;\n' +
'function cyclePh(){if(document.activeElement===nInp||nInp.value)return;nInp.placeholder=demos[di=(di+1)%demos.length]}\n' +
'setInterval(cyclePh,2200);cyclePh();\n' +
'var twEl=document.getElementById("tw"),twI=0,twC=demos[0].length,twDel=true;\n' +
'function tw(){var w=demos[twI];if(twDel){twEl.textContent=w.substring(0,--twC);if(twC===0){twDel=false;twI=(twI+1)%demos.length;setTimeout(tw,500);return}}else{twEl.textContent=w.substring(0,++twC);if(twC===w.length){twDel=true;setTimeout(tw,1800);return}}setTimeout(tw,twDel?55:105)}\n' +
'setTimeout(tw,1500);\n' +
'function updateCta(){var v=ta.value.trim();if(!v){submitBtn.textContent="生成 →";th.textContent="";return}if(/^https?:\\/\\//i.test(v)){submitBtn.textContent="生成短链 →";th.textContent="URL · 302 短链"}else{submitBtn.textContent="生成笔记 →";th.textContent=v.length+" 字 · 笔记页"}}\n' +
'ta.addEventListener("input",function(){updateCta();if(mdShell.classList.contains("previewing"))renderPreview()});updateCta();\n' +
'function checkName(){var v=normalizeNameInput(nInp.value);nInp.value=v;if(!v){setStatus("","");setErr(false);nameAvailable=null;return}if(!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(v)){setStatus("格式：小写字母/数字/-","err");setErr(true);nameAvailable=false;return}setStatus("检查中…","pending");fetch("/exists?n="+encodeURIComponent(v)).then(function(r){return r.json()}).then(function(d){if(normalizeNameInput(nInp.value)!==v)return;if(!d.valid){var s=nameStatusForReason(d);setStatus(s.msg,s.cls);setErr(true);nameAvailable=false}else if(d.exists){setStatus("已被占用（本人创建请用编辑链接）","warn");setErr(false);nameAvailable=false}else{setStatus("✓ 可用","ok");setErr(false);nameAvailable=true}}).catch(function(){setStatus("","")})}\n' +
'nInp.addEventListener("input",function(){clearTimeout(checkTimer);checkTimer=setTimeout(checkName,500)});\n' +
'if(nInp.value)checkName();\n' +
'function getTtl(){var r=document.querySelector(\'input[name="ttl"]:checked\');return r?r.value:"' + DEFAULT_TTL + '"}\n' +
'function go(e){e.preventDefault();var nameVal=normalizeNameInput(nInp.value);nInp.value=nameVal;if(nameVal&&nameAvailable===false){setErr(true);nInp.focus();return false}var c=ta.value;var t=getTtl();var p=new URLSearchParams();if(nameVal)p.set("n",nameVal);p.set("c",c);if(t&&t!=="' + DEFAULT_TTL + '")p.set("ttl",t);location.href="/?"+p.toString();return false}\n' +
'</script>\n' +
'</body></html>';
  return html(body);
}

export function resultPage(name, content, mode, ttlKey, editToken) {
  // mode: "created" | "updated"
  const short = "https://" + name + "." + BASE_HOST;
  const editUrl = editToken ? (short + "/edit#t=" + editToken) : null;
  const link = isUrl(content);
  const allowed = link && isAllowedTarget(content);
  const header = mode === "updated" ? "已更新" : "已创建";
  const ttlMap = { "1h": "1 小时", "1d": "1 天", "7d": "7 天" };
  const ttlDisplay = ttlKey ? (ttlMap[ttlKey] || ttlKey) : null;
  const qrSrc = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" + encodeURIComponent(short);
  const hostForHint = link ? ((parseUrlSafe(content) || {}).hostname || '') : '';


  // Status sub-line: "已创建 · 1 天后过期"
  const statusLine = '<div class="status">' + esc(header) +
    (ttlDisplay ? ' · ' + esc(ttlDisplay) + '后过期' : '') + '</div>';

  // Security: only surface the warning interstitial hint when target is NOT allowlisted.
  // Success path is silent — users don't need a green checkmark on every create.
  const whitelistBlock = (link && !allowed)
    ? ('<div class="wl wl-warn"><span class="wl-ic">🛡️</span><span><code>' + esc(hostForHint) + '</code> 不在白名单，访问者会先看到跳转确认页。</span></div>\n')
    : '';

  // Edit URL is sensitive and one-time. Single ghost button + tiny hint, nothing more.
  const editBlock = editUrl ? (
    '<div class="edit-block">\n' +
    '<button type="button" class="btn ghost edit-btn" data-copy="' + esc(editUrl) + '" data-label="🔑 复制编辑链接（仅一次）" onclick="copyFromButton(this)">🔑 复制编辑链接（仅一次）</button>\n' +
    '<small class="edit-hint">关掉就拿不回了</small>\n' +
    '</div>\n'
  ) : '';

  // Collapsed details: QR + raw + (for links) target preview. Hidden by default.
  const targetRow = link
    ? ('<div class="d-row"><span class="d-k">目标</span><a class="d-v" href="' + esc(content.trim()) + '" rel="noopener">' + esc(content.trim().slice(0, 80)) + (content.trim().length > 80 ? '…' : '') + '</a></div>')
    : ('<div class="d-row"><span class="d-k">长度</span><span class="d-v">' + content.length + ' 字符</span></div>');
  const moreBlock =
    '<details class="more">\n' +
    '<summary>更多（二维码 / 原文）</summary>\n' +
    '<div class="more-body">\n' +
    '<div class="qr"><img alt="QR" src="' + esc(qrSrc) + '" width="160" height="160" loading="lazy"></div>\n' +
    '<div class="d-row"><span class="d-k">原文</span><a class="d-v" href="' + esc(short) + '/raw">/raw</a></div>\n' +
    targetRow +
    '</div>\n' +
    '</details>\n';

  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + header + ' · ' + esc(name) + '</title>\n' +
'<style>\n' + COMMON_CSS + '\n' +
'body{padding-top:clamp(20px,6vw,56px)}\n' +
'.card{border-radius:20px;box-shadow:0 2px 12px rgba(0,0,0,.028)}\n' +
'@media(prefers-color-scheme:dark){.card{box-shadow:0 2px 12px rgba(0,0,0,.35)}}\n' +
'.brand{font-family:var(--mono);font-size:clamp(2rem,7vw,2.6rem);font-weight:800;letter-spacing:-.04em;line-height:1;text-align:center;margin:0 0 .4rem}\n' +
'.brand .dot{color:#10b981}\n' +
'.status{text-align:center;color:var(--faint);font-size:.82rem;margin:0 0 1.4rem;letter-spacing:.005em}\n' +
'.url-card{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:.4rem;align-items:stretch;border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:.4rem .4rem .4rem .85rem;margin-bottom:1.4rem}\n' +
'.url-card .short-link{display:flex;align-items:center;min-width:0;font-family:var(--mono);font-size:.95rem;color:var(--text);text-decoration:none;word-break:break-all;line-height:1.35;padding:.3rem 0}\n' +
'@media(hover:hover){.url-card .short-link:hover{opacity:.75}}\n' +
'.url-card .btn{min-height:36px;padding:0 .9rem;font-size:.85rem;white-space:nowrap}\n' +
'@media(max-width:520px){.url-card{grid-template-columns:1fr 1fr;padding:.6rem}.url-card .short-link{grid-column:1/-1;padding:.4rem .25rem .35rem}.url-card .btn{justify-content:center}}\n' +
'.edit-block{margin:0 0 1.4rem;text-align:center}\n' +
'.edit-block .edit-btn{width:100%;min-height:44px;font-size:.9rem;background:var(--surface)}\n' +
'.edit-block .edit-hint{display:block;color:var(--faint);font-size:.74rem;margin-top:.5rem}\n' +
'.wl{display:flex;gap:.5rem;align-items:flex-start;margin:0 0 1.2rem;padding:.6rem .8rem;border-radius:8px;font-size:.8rem;line-height:1.5}\n' +
'.wl .wl-ic{flex:0 0 auto;font-size:.9rem;line-height:1.4}\n' +
'.wl code{font-family:var(--mono);background:rgba(128,128,128,.18);padding:.02rem .28rem;border-radius:3px;font-size:.9em}\n' +
'.wl.wl-warn{background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.22);color:var(--text)}\n' +
'.wl.wl-warn code{color:var(--warn)}\n' +
'.more{margin-top:.25rem;border-top:1px solid var(--border);padding-top:.85rem}\n' +
'.more>summary{cursor:pointer;color:var(--faint);font-size:.8rem;list-style:none;padding:.2rem 0;-webkit-tap-highlight-color:transparent;user-select:none}\n' +
'.more>summary::-webkit-details-marker{display:none}\n' +
'.more>summary::before{content:"▸";display:inline-block;margin-right:.4rem;transition:transform .15s;font-size:.85em}\n' +
'.more[open]>summary::before{transform:rotate(90deg)}\n' +
'@media(hover:hover){.more>summary:hover{color:var(--text)}}\n' +
'.more-body{padding-top:.95rem;display:flex;flex-direction:column;gap:.85rem;align-items:center}\n' +
'.qr{padding:8px;border-radius:10px;background:#fff;border:1px solid var(--border);width:fit-content}\n' +
'.qr img{display:block;width:160px;height:160px}\n' +
'.d-row{display:flex;gap:.85rem;font-size:.82rem;width:100%;justify-content:space-between;align-items:baseline}\n' +
'.d-row .d-k{color:var(--faint);flex:0 0 auto}\n' +
'.d-row .d-v{color:var(--text);text-decoration:none;border-bottom:1px dotted var(--border-strong);word-break:break-all;text-align:right;min-width:0}\n' +
'.d-row a.d-v:hover{border-bottom-style:solid}\n' +
'.mini-foot{text-align:center;color:var(--faint);font-size:.72rem;margin-top:1.5rem}\n' +
'.mini-foot a{color:inherit;text-decoration:none}\n' +
'@media(hover:hover){.mini-foot a:hover{color:var(--text)}}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
'<div class="card">\n' +
'<h1 class="brand">0g<span class="dot">.</span>hk<span class="dot">.</span></h1>\n' +
 statusLine + '\n' +
'<div class="url-card"><a class="short-link" href="' + esc(short) + '" target="_blank" rel="noopener noreferrer">' + esc(short) + '</a><button type="button" class="btn ghost" data-copy="' + esc(short) + '" data-label="复制" onclick="copyFromButton(this)">复制</button><a class="btn primary" href="' + esc(short) + '" target="_blank" rel="noopener noreferrer">打开</a></div>\n' +
 whitelistBlock + editBlock + moreBlock +
'</div>\n' +
'<div class="mini-foot"><a href="https://' + BASE_HOST + '/">' + BASE_HOST + '</a></div>\n' +
'</div>\n' +
'<script>function copyFromButton(b){var label=b.getAttribute("data-label")||"复制";navigator.clipboard.writeText(b.getAttribute("data-copy")||"").then(function(){b.textContent="已复制";setTimeout(function(){b.textContent=label},1500)})}</script>\n' +
'</body></html>';
  return html(body);
}

export function notePage(sub, content) {
  const isShortPlain = content.length <= 40 && !/[#*_`>\[\]-]|\n/.test(content);
  const bodyClass = isShortPlain ? 'markdown-body big' : 'markdown-body';
  const segRight =
    '<div class="seg"><button type="button" onclick="navigator.clipboard.writeText(document.getElementById(\'raw-copy\').value).then(function(){var b=event.currentTarget;b.textContent=\'已复制\';setTimeout(function(){b.textContent=\'复制\'},1200)})">复制</button>' +
    '<a href="/raw">原文</a></div>';
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(sub) + ' · ' + BASE_HOST + '</title>\n' +
'<meta name="robots" content="noindex">\n' +
'<style>\n' + COMMON_CSS + '\n' +
'.markdown-body{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(1rem,3vw,1.35rem);font-size:1rem;line-height:1.72;color:var(--text);overflow-wrap:anywhere}\n' +
'.markdown-body>:first-child{margin-top:0}.markdown-body>:last-child{margin-bottom:0}\n' +
'.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6{line-height:1.25;margin:1.2em 0 .55em;letter-spacing:0;color:var(--text)}\n' +
'.markdown-body h1{font-size:1.65rem}.markdown-body h2{font-size:1.35rem}.markdown-body h3{font-size:1.12rem}.markdown-body h4,.markdown-body h5,.markdown-body h6{font-size:1rem}\n' +
'.markdown-body p{margin:.72em 0}.markdown-body a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}.markdown-body strong{font-weight:700}.markdown-body del{color:var(--muted)}\n' +
'.markdown-body ul,.markdown-body ol{padding-left:1.35rem;margin:.75em 0}.markdown-body li+li{margin-top:.28em}\n' +
'.markdown-body blockquote{margin:.95em 0;padding:.1rem 0 .1rem .9rem;border-left:3px solid var(--border-strong);color:var(--muted)}\n' +
'.markdown-body code{font-family:var(--mono);font-size:.9em;background:rgba(128,128,128,.14);border:1px solid var(--border);border-radius:4px;padding:.08rem .28rem}\n' +
'.markdown-body pre{margin:1em 0;padding:.9rem 1rem;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;overflow:auto;line-height:1.58;-webkit-overflow-scrolling:touch}\n' +
'.markdown-body pre code{display:block;background:transparent;border:0;border-radius:0;padding:0;white-space:pre;font-size:.88rem;color:var(--text)}\n' +
'.markdown-body hr{border:0;border-top:1px solid var(--border);margin:1.25rem 0}\n' +
'.markdown-body.big{font-size:clamp(1.3rem,4vw,1.8rem);line-height:1.45;text-align:center;padding:clamp(1.5rem,5vw,2.25rem) clamp(1rem,3vw,1.25rem);font-weight:500}\n' +
'.raw-copy{position:absolute;left:-9999px;top:auto;width:1px;height:1px;opacity:0}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
headerHtml(segRight) + '\n' +
'<textarea id="raw-copy" class="raw-copy" readonly>' + esc(content) + '</textarea>\n' +
'<article id="c" class="' + bodyClass + '">' + renderMarkdown(content) + '</article>\n' +
promoCardHtml() + '\n' +
footerHtml() + '\n' +
'</div>\n' +
'</body></html>';
  return html(body);
}

export function interstitialPage(sub, target) {
  const parsed = parseUrlSafe(target);
  const host = parsed ? parsed.hostname : target;
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>即将跳转 · ' + BASE_HOST + '</title>\n' +
'<meta name="robots" content="noindex">\n' +
'<style>\n' + COMMON_CSS + '\n' +
'.warn-card{max-width:560px;margin-left:auto;margin-right:auto;border-left:3px solid var(--warn)}\n' +
'.warn-card h2{margin:0 0 .5rem;font-size:1.05rem;font-weight:600}\n' +
'.warn-lead{font-size:.88rem;color:var(--muted);margin:0 0 1rem;line-height:1.55}\n' +
'.host{font-family:var(--mono);font-size:1.05rem;font-weight:600;color:var(--warn);word-break:break-all;line-height:1.4;margin:0 0 .75rem}\n' +
'.target{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;margin:0 0 1.25rem;font-family:var(--mono);font-size:.82rem;word-break:break-all;line-height:1.5;color:var(--text)}\n' +
'.act{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center}\n' +
'.act .links{margin-left:auto;font-size:.8rem;color:var(--faint)}\n' +
'.act .links a{color:inherit;text-decoration:none;cursor:pointer}\n' +
'@media(hover:hover){.act .links a:hover{color:var(--text)}}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
headerHtml() + '\n' +
'<div class="card warn-card">\n' +
'<h2>即将离开 ' + BASE_HOST + '</h2>\n' +
'<p class="warn-lead">此链接由用户创建，不在可信白名单。请先确认目标域名：</p>\n' +
'<div class="host">' + esc(host) + '</div>\n' +
'<div class="target">' + esc(target) + '</div>\n' +
'<div class="act">\n' +
'<a class="btn primary" rel="noopener noreferrer nofollow" href="' + esc(target) + '">确认继续 →</a>\n' +
'<span class="links"><a href="#" onclick="return rep()">举报此链接</a></span>\n' +
'</div>\n' +
'</div>\n' +
footerHtml() + '\n' +
'</div>\n' +
'<script>function rep(){if(!confirm("确认举报此链接为钓鱼/恶意/欺诈？"))return false;fetch("/abuse/report",{method:"POST",headers:{accept:"application/json"}}).then(function(r){return r.json()}).then(function(j){alert(j && j.disabled?"举报已提交，链接已被自动禁用。":"举报已提交，感谢协助。")}).catch(function(){alert("网络错误，稍后重试。")});return false}</script>\n' +
'</body></html>';
  return html(body);
}

export function editNotePage(sub, ttlKey) {
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>编辑 ' + esc(sub) + ' · ' + BASE_HOST + '</title>\n' +
'<meta name="robots" content="noindex">\n' +
'<style>\n' + COMMON_CSS + '\n' +
'.meta{font-family:var(--mono);font-size:.85rem;color:var(--faint);margin-bottom:1rem}\n' +
'.meta strong{color:var(--text)}\n' +
'.row{display:flex;gap:.75rem;align-items:center;margin-top:1.25rem}\n' +
'.row button{flex:0 0 auto}\n' +
'.row .status{flex:1;font-size:.85rem;color:var(--faint);min-height:1.2em}\n' +
'.status.ok{color:var(--ok)}.status.err{color:var(--err)}\n' +
'.error-box{background:#fee2e2;border:1px solid #fca5a5;color:#991b1b;border-radius:8px;padding:1rem;font-size:.9rem;line-height:1.5}\n' +
'@media(prefers-color-scheme:dark){.error-box{background:#2a0e0e;border-color:#7f1d1d;color:#fca5a5}}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
headerHtml() + '\n' +
'<div class="card">\n' +
'<h1>编辑笔记</h1>\n' +
'<div class="meta"><strong>' + esc(sub) + '.' + BASE_HOST + '</strong> · 保留 ' + esc(ttlKey) + '</div>\n' +
'<div id="wrap" style="display:none">\n' +
'<textarea id="c" autofocus></textarea>\n' +
'<div class="row"><button id="s" onclick="save()">保存</button><span id="st" class="status"></span></div>\n' +
'</div>\n' +
'<div id="err" class="error-box" style="display:none"></div>\n' +
'</div>\n' +
 footerHtml() + '\n' +
'</div>\n' +
'<script>\n' +
'var tm=location.hash.match(/t=([A-Za-z0-9_-]+)/);\n' +
'var token=tm?tm[1]:"";\n' +
'var wrap=document.getElementById("wrap"),errBox=document.getElementById("err"),ta=document.getElementById("c"),st=document.getElementById("st"),sb=document.getElementById("s");\n' +
'function showErr(m){errBox.textContent=m;errBox.style.display=""}\n' +
'function setStatus(m,cls){st.textContent=m;st.className="status "+(cls||"")}\n' +
'if(!token){showErr("缺少编辑 token。请使用完整的编辑链接（包含 #t=...）。")}\n' +
'else{fetch("/raw").then(function(r){if(!r.ok)throw r.status;return r.text()}).then(function(t){ta.value=t;wrap.style.display=""}).catch(function(e){showErr("加载失败："+e+"。笔记可能已过期或不存在。")})}\n' +
'function save(){var c=ta.value;if(!c){setStatus("内容不能为空","err");return}sb.disabled=true;setStatus("保存中…");var u="/?edit="+encodeURIComponent(token)+"&c="+encodeURIComponent(c);fetch(u).then(function(r){sb.disabled=false;if(r.ok){setStatus("已保存 ✓","ok");setTimeout(function(){setStatus("")},2500)}else if(r.status===403){setStatus("保存失败：编辑链接无效","err")}else if(r.status===429){setStatus("保存失败：频率超限，稍后再试","err")}else{setStatus("保存失败："+r.status,"err")}}).catch(function(e){sb.disabled=false;setStatus("网络错误："+e,"err")})}\n' +
'document.addEventListener("keydown",function(e){if((e.metaKey||e.ctrlKey)&&e.key==="s"){e.preventDefault();save()}});\n' +
'</script>\n' +
'</body></html>';
  // Edit page carries an auth token in the fragment; never cache.
  return html(body, 200, { "cache-control": "no-store" });
}

export function notFoundPage(sub) {
  const body = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(sub) + ' · 还没人占用</title>' +
'<meta name="robots" content="noindex">' +
'<style>\n' + COMMON_CSS + '\n' +
'.nf-body{text-align:center}\n' +
'.tag{font-size:.76rem;color:var(--faint);letter-spacing:.08em;text-transform:uppercase;margin-bottom:.6rem}\n' +
'.sub-name{font-family:var(--mono);font-size:clamp(1.1rem,4vw,1.35rem);font-weight:600;color:var(--warn);word-break:break-all;margin-bottom:.5rem;line-height:1.3}\n' +
'.lead{font-size:.9rem;color:var(--muted);margin:0}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
headerHtml() + '\n' +
'<div class="card nf-body">\n' +
'<div class="tag">404 · 还没人占用</div>\n' +
'<div class="sub-name">' + esc(sub) + '.' + BASE_HOST + '</div>\n' +
'<div class="lead">这个子域名空着，想要么？</div>\n' +
'</div>\n' +
'<a class="promo" href="https://' + BASE_HOST + '/?n=' + encodeURIComponent(sub) + '">' +
'<span class="promo-t">占下 <span style="font-family:var(--mono)">' + esc(sub) + '</span> →</span>' +
'<span class="promo-s">把文字或链接变成你的 <code>' + esc(sub) + '.' + BASE_HOST + '</code></span>' +
'<span class="promo-cta">去创建 →</span>' +
'</a>\n' +
footerHtml() + '\n' +
'</div>\n' +
'</body></html>';
  return html(body, 404);
}
