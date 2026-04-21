// Page renderers (editor, result, note, interstitial, editNote, notFound).
// Extracted verbatim from src/index.js.
import { BASE_HOST, TTL_OPTIONS, DEFAULT_TTL, ABUSE_EMAIL } from "./constants.js";
import { esc, shortUrlFor, isUrl, parseUrlSafe } from "./util.js";
import { COMMON_CSS, html, footerHtml, headerHtml, promoCardHtml } from "./responses.js";

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
// Textarea: softer default + subtle focus ring (overrides COMMON_CSS outline).
'textarea{min-height:5rem;border-color:var(--border);font-size:.95rem}@supports(field-sizing:content){textarea{field-sizing:content;min-height:3.5rem}}\n' +
'textarea:focus{outline:0;border-color:var(--text);box-shadow:0 0 0 3px rgba(17,17,17,.06)}\n' +
'@media(prefers-color-scheme:dark){textarea:focus{box-shadow:0 0 0 3px rgba(237,237,237,.08)}}\n' +
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
'.name-status.ok{color:var(--ok)}.name-status.warn{color:var(--warn)}.name-status.err{color:var(--err)}\n' +
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
// Scenarios — tighter margin, compact cards.
'.scn{display:grid;gap:.7rem;grid-template-columns:minmax(0,1fr);margin-top:1.25rem}\n' +
'@media(min-width:760px){.scn{grid-template-columns:repeat(3,minmax(0,1fr));gap:.85rem}}\n' +
'.s-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:.9rem 1rem;line-height:1.5;display:flex;flex-direction:column;gap:.4rem;min-width:0}\n' +
'.s-head{display:flex;gap:.45rem;align-items:baseline}\n' +
'.s-emoji{font-size:1rem;line-height:1;flex-shrink:0}\n' +
'.s-title{font-weight:600;color:var(--text);font-size:.9rem}\n' +
'.s-desc{color:var(--muted);font-size:.8rem;line-height:1.5}\n' +
'.s-card pre{font-family:var(--mono);font-size:.72rem;background:rgba(128,128,128,.08);padding:.55rem .65rem;border-radius:6px;color:var(--text);overflow-x:auto;white-space:pre;line-height:1.55;margin-top:auto;-webkit-overflow-scrolling:touch}\n' +
'.s-card pre::-webkit-scrollbar{height:0}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
'<div class="card">\n' +
'<h1 class="brand"><span id="tw" class="tw">demo</span><span class="cursor"></span><span class="dot">.</span>0g<span class="dot">.</span>hk</h1>\n' +
'<div class="tagline">把想说的，一秒变成一条链接。</div>\n' +
(alertTop ? '<div class="alert-warn">' + alertTop + '</div>\n' : '') +
'<form onsubmit="return go(event)">\n' +
'<label for="c" class="sr">内容</label>' +
'<textarea id="c" required autofocus rows="3" placeholder="粘贴文字，或 https://…">' + esc(prefillContent) + '</textarea>\n' +
'<div class="type-hint" id="typeHint"></div>\n' +
'<div class="cap"><span>子域名字</span><span class="hint-r">留空 = 随机分配</span></div>\n' +
'<div class="name-wrap' + (errorName ? ' err' : '') + '" id="nw"><input id="n" value="' + esc(prefillName) + '" autocomplete="off" inputmode="url" pattern="[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?" placeholder="talk" aria-label="自定义子域名"><span class="suffix">.' + BASE_HOST + '</span></div>' +
'<span id="ns" class="name-status' + (errorName ? ' err' : '') + '">' + esc(errorName) + '</span>\n' +
'<div class="action"><div class="ttl-row"><span class="lbl">保留</span>' + ttlChips + '</div>' +
'<button type="submit" id="submitBtn">生成 →</button></div>\n' +
'</form>\n' +
'</div>\n' +
'<section class="scn" aria-label="用法">\n' +
'<div class="s-card"><div class="s-head"><span class="s-emoji">📋</span><span class="s-title">分享临时文本</span></div><div class="s-desc">剪贴板 → 一个可分享的 URL</div><pre>pbpaste | curl -d @- 0g.hk</pre></div>\n' +
'<div class="s-card"><div class="s-head"><span class="s-emoji">🔗</span><span class="s-title">好记的短链</span></div><div class="s-desc">子域名即文案，比哈希好记 10 倍</div><pre>curl -d https://… 0g.hk/?n=talk</pre></div>\n' +
'<div class="s-card"><div class="s-head"><span class="s-emoji">🤖</span><span class="s-title">让 AI 帮你建</span></div><div class="s-desc">curl 主页直接返回说明书</div><pre>curl 0g.hk  # AI 读完就会用</pre></div>\n' +
'</section>\n' +
 footerHtml() + '\n' +
'</div>\n' +
'<script>\n' +
'var nInp=document.getElementById("n"),nw=document.getElementById("nw"),ns=document.getElementById("ns"),submitBtn=document.getElementById("submitBtn"),ta=document.getElementById("c"),th=document.getElementById("typeHint");\n' +
'var checkTimer=null,nameAvailable=null;\n' +
'function setErr(on){if(on)nw.classList.add("err");else nw.classList.remove("err")}\n' +
'function setStatus(msg,cls){ns.textContent=msg;ns.className="name-status "+(cls||"")}\n' +
// Rotating placeholder hints that name is customizable.
'var demos=["talk","q3-plan","read-me","demo","party","notes"],di=0;\n' +
'function cyclePh(){if(document.activeElement===nInp||nInp.value)return;nInp.placeholder=demos[di=(di+1)%demos.length]}\n' +
'setInterval(cyclePh,2200);cyclePh();\n' +
'var twEl=document.getElementById("tw"),twI=0,twC=demos[0].length,twDel=true;\n' +
'function tw(){var w=demos[twI];if(twDel){twEl.textContent=w.substring(0,--twC);if(twC===0){twDel=false;twI=(twI+1)%demos.length;setTimeout(tw,500);return}}else{twEl.textContent=w.substring(0,++twC);if(twC===w.length){twDel=true;setTimeout(tw,1800);return}}setTimeout(tw,twDel?55:105)}\n' +
'setTimeout(tw,1500);\n' +
'function updateCta(){var v=ta.value.trim();if(!v){submitBtn.textContent="生成 →";th.textContent="";return}if(/^https?:\\/\\//i.test(v)){submitBtn.textContent="生成短链 →";th.textContent="URL · 302 短链"}else{submitBtn.textContent="生成笔记 →";th.textContent=v.length+" 字 · 笔记页"}}\n' +
'ta.addEventListener("input",updateCta);updateCta();\n' +
'function checkName(){var v=nInp.value.trim().toLowerCase();if(!v){setStatus("","");setErr(false);nameAvailable=null;return}if(!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(v)){setStatus("格式：小写字母/数字/-，2–32 位，首尾非 -","err");setErr(true);nameAvailable=false;return}setStatus("检查中…","pending");fetch("/exists?n="+encodeURIComponent(v)).then(function(r){return r.json()}).then(function(d){if(nInp.value.trim().toLowerCase()!==v)return;if(!d.valid){setStatus("不可用：保留名或格式无效","err");setErr(true);nameAvailable=false}else if(d.exists){setStatus("已被占用（本人创建请用编辑链接）","warn");setErr(false);nameAvailable=false}else{setStatus("✓ 可用","ok");setErr(false);nameAvailable=true}}).catch(function(){setStatus("","")})}\n' +
'nInp.addEventListener("input",function(){clearTimeout(checkTimer);checkTimer=setTimeout(checkName,300)});\n' +
'if(nInp.value)checkName();\n' +
'function getTtl(){var r=document.querySelector(\'input[name="ttl"]:checked\');return r?r.value:"' + DEFAULT_TTL + '"}\n' +
'function go(e){e.preventDefault();var nameVal=nInp.value.trim();if(nameVal&&nameAvailable===false){setErr(true);nInp.focus();return false}var c=ta.value;var t=getTtl();var p=new URLSearchParams();if(nameVal)p.set("n",nameVal);p.set("c",c);if(t&&t!=="' + DEFAULT_TTL + '")p.set("ttl",t);location.href="/?"+p.toString();return false}\n' +
'</script>\n' +
'</body></html>';
  return html(body);
}

export function resultPage(name, content, mode, ttlKey, editToken) {
  // mode: "created" | "updated"
  const short = "https://" + name + "." + BASE_HOST;
  const editUrl = editToken ? (short + "/edit#t=" + editToken) : null;
  const link = isUrl(content);
  const typeClass = link ? "link" : "note";
  const allowed = link && isAllowedTarget(content);
  const typeLabel = link ? (allowed ? "302 直跳" : "需确认") : "笔记";
  const header = mode === "updated" ? "已更新" : "已创建";
  const ttlMap = { "1h": "1 小时", "1d": "1 天", "7d": "7 天" };
  const ttlDisplay = ttlKey ? (ttlMap[ttlKey] || ttlKey) : null;
  const qrSrc = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=" + encodeURIComponent(short);
  const hostForHint = link ? ((parseUrlSafe(content) || {}).hostname || '') : '';

  // Compact edit card: title on top, inline [input + copy] row, one-line subtitle below.
  const editBlock = editUrl ? (
    '<div class="edit-card">\n' +
    '<div class="ec-h">🔑 编辑链接 · 仅此一次</div>\n' +
    '<div class="url"><input id="eu" value="' + esc(editUrl) + '" readonly onclick="this.select()"><button class="secondary" onclick="copyEdit(this)">复制</button></div>\n' +
    '<div class="ec-s">拿到这个链接的人可以修改 <code>' + esc(name) + '</code> 的内容，关掉本页就找不回来了。</div>\n' +
    '</div>\n'
  ) : '';

  // Whitelist hint — single compact line. Only shown for links.
  const whitelistBlock = (link && !allowed)
    ? ('<div class="wl wl-warn"><span class="wl-ic">🛡️</span><span><code>' + esc(hostForHint) + '</code> 不在白名单，访问者会先看到跳转确认页。</span></div>\n')
    : (link && allowed)
      ? ('<div class="wl wl-ok"><span class="wl-ic">✓</span><span><code>' + esc(hostForHint) + '</code> 在白名单，访问者直接 302 跳转。</span></div>\n')
      : '';

  // Meta rows — 2-col definition grid instead of loose br-separated lines.
  const targetRow = link
    ? ('<dt>目标</dt><dd><a href="' + esc(content.trim()) + '" rel="noopener">' + esc(content.trim().slice(0, 80)) + (content.trim().length > 80 ? '…' : '') + '</a></dd>')
    : ('<dt>长度</dt><dd>' + content.length + ' 字符</dd>');
  const ttlRow = ttlDisplay ? ('<dt>保留</dt><dd>' + esc(ttlDisplay) + '</dd>') : '';
  const metaHtml = '<dl class="meta">' +
    '<dt>原文</dt><dd><a href="' + esc(short) + '/raw">/raw</a></dd>' +
    targetRow + ttlRow +
    '</dl>';

  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + header + ' · ' + esc(name) + '</title>\n' +
'<style>\n' + COMMON_CSS + '\n' +
'h1{font-size:1.05rem;font-weight:600;margin:0 0 1rem;display:flex;gap:.5rem;align-items:center;letter-spacing:-.005em}\n' +
'h1 .dot{width:6px;height:6px;border-radius:50%;background:var(--ok);display:inline-block;flex:0 0 auto}\n' +
'.type{padding:.12rem .5rem;border-radius:999px;font-size:.7rem;font-weight:600;letter-spacing:.01em}\n' +
'.type.link{background:#e0f2fe;color:#0369a1}\n' +
'.type.note{background:#fef3c7;color:#92400e}\n' +
'@media(prefers-color-scheme:dark){.type.link{background:rgba(14,165,233,.18);color:#7dd3fc}.type.note{background:rgba(251,191,36,.18);color:#fcd34d}}\n' +
'.url{display:flex;gap:.5rem;margin-bottom:0}\n' +
'.url input{flex:1;font-family:var(--mono);font-size:.95rem;padding:.6rem .8rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);min-height:40px}\n' +
'.url button{padding:.55rem 1rem;font-size:.88rem;min-height:40px}\n' +
'.primary-url{margin-bottom:1rem}\n' +
'.edit-card{margin:0 0 1rem;padding:.85rem .95rem;border-radius:10px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);border-left:3px solid var(--warn)}\n' +
'.edit-card .ec-h{font-size:.82rem;font-weight:600;margin-bottom:.55rem;color:var(--warn)}\n' +
'.edit-card .url{margin-bottom:.55rem}\n' +
'.edit-card .ec-s{font-size:.76rem;color:var(--muted);line-height:1.5}\n' +
'.edit-card code{font-family:var(--mono);background:rgba(128,128,128,.15);padding:.02rem .28rem;border-radius:3px;font-size:.82em}\n' +
'.wl{display:flex;gap:.5rem;align-items:flex-start;margin:0 0 1rem;padding:.6rem .8rem;border-radius:8px;font-size:.8rem;line-height:1.5}\n' +
'.wl .wl-ic{flex:0 0 auto;font-size:.9rem;line-height:1.4}\n' +
'.wl code{font-family:var(--mono);background:rgba(128,128,128,.18);padding:.02rem .28rem;border-radius:3px;font-size:.9em}\n' +
'.wl.wl-warn{background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.22);color:var(--text)}\n' +
'.wl.wl-warn code{color:var(--warn)}\n' +
'.wl.wl-ok{background:rgba(5,150,105,.06);border:1px solid rgba(5,150,105,.22);color:var(--text)}\n' +
'.wl.wl-ok .wl-ic{color:var(--ok);font-weight:700}\n' +
'.meta{margin:1rem 0 0;padding:.85rem 1rem;border:1px solid var(--border);border-radius:10px;background:var(--surface);display:grid;grid-template-columns:4rem 1fr;gap:.45rem .85rem;font-size:.83rem;line-height:1.5}\n' +
'.meta dt{color:var(--faint);font-weight:500}\n' +
'.meta dd{color:var(--text);word-break:break-all;overflow:hidden;text-overflow:ellipsis}\n' +
'.meta a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--border-strong)}\n' +
'.meta a:hover{border-bottom-style:solid}\n' +
'.qr{margin:1.25rem auto 0;width:fit-content;padding:8px;border-radius:10px;background:#fff;border:1px solid var(--border)}\n' +
'.qr img{display:block;width:120px;height:120px}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
headerHtml() + '\n' +
'<div class="card">\n' +
'<h1><span class="dot"></span>' + header + '<span class="type ' + typeClass + '">' + typeLabel + '</span></h1>\n' +
'<div class="url primary-url"><input id="u" value="' + esc(short) + '" readonly onclick="this.select()"><button onclick="copyShort(this)">复制</button></div>\n' +
 whitelistBlock + editBlock + metaHtml + '\n' +
'<div class="qr"><img alt="QR" src="' + esc(qrSrc) + '" width="120" height="120" loading="lazy"></div>\n' +
'</div>\n' +
footerHtml() + '\n' +
'</div>\n' +
'<script>function copyShort(b){navigator.clipboard.writeText(document.getElementById("u").value).then(function(){b.textContent="已复制";setTimeout(function(){b.textContent="复制"},1500)})}function copyEdit(b){navigator.clipboard.writeText(document.getElementById("eu").value).then(function(){b.textContent="已复制";setTimeout(function(){b.textContent="复制"},1500)})}</script>\n' +
'</body></html>';
  return html(body);
}

export function notePage(sub, content) {
  const isShort = content.length <= 40 && !/\n/.test(content);
  const preClass = isShort ? 'note-pre big' : 'note-pre';
  const segRight =
    '<div class="seg"><button type="button" onclick="navigator.clipboard.writeText(document.getElementById(\'c\').innerText).then(function(){var b=event.currentTarget;b.textContent=\'已复制\';setTimeout(function(){b.textContent=\'复制\'},1200)})">复制</button>' +
    '<a href="/raw">原文</a></div>';
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(sub) + ' · ' + BASE_HOST + '</title>\n' +
'<meta name="robots" content="noindex">\n' +
'<style>\n' + COMMON_CSS + '\n' +
'.note-pre{white-space:pre-wrap;word-wrap:break-word;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(1rem,3vw,1.25rem);font-family:var(--mono);font-size:.95rem;line-height:1.6;color:var(--text);margin:0}\n' +
'.note-pre.big{font-size:clamp(1.3rem,4vw,1.8rem);line-height:1.45;text-align:center;padding:clamp(1.5rem,5vw,2.25rem) clamp(1rem,3vw,1.25rem);font-weight:500}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
headerHtml(segRight) + '\n' +
'<pre id="c" class="' + preClass + '">' + esc(content) + '</pre>\n' +
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
