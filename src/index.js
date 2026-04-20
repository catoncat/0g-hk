// 0g.hk — 临时笔记 + 302 短链
//
// Browser (HTML, backwards compat):
//   GET  /                              -> 编辑器
//   GET  /?c=...&n=...&ttl=...          -> 创建（HTML 结果页，同名 → 编辑器内联错误）
//   GET  <name>.0g.hk                   -> 白名单 302 / 跳转中间页 / 笔记页
//   GET  <name>.0g.hk/?go=1             -> 绕过跳转中间页
//   GET  <name>.0g.hk/?edit=<tk>&c=...  -> 以 token 覆盖（HTML 结果页）
//   GET  <name>.0g.hk/edit              -> 编辑器 UI（#t= fragment 读 token）
//
// CLI / automation (JSON + metadata headers):
//   GET  /exists?n=<name>               -> {valid, exists, reason?}
//   POST /                              -> 创建；body: application/json | form | text/plain
//   POST <name>.0g.hk/?edit=<tk>        -> 覆盖；body 同上
//   GET  <name>.0g.hk/raw               -> 原文 + 元数据 header
//   GET  <name>.0g.hk/?format=json      -> 元数据 + 原文（不含 token）
//
//   Opt-in JSON: Accept: application/json 或 ?format=json
//   Metadata headers on create/read/302:
//     X-Name, X-Short-Url, X-Raw-Url, X-Kind (url|text),
//     X-Ttl, X-Expires-At, X-Created-At, X-Target, X-Edit-Token, X-Edit-Url
//   Error JSON: {ok:false, error:{code, message, ...}}
//   OPTIONS * -> CORS preflight

const BASE_HOST = "0g.hk";
const RESERVED = new Set(["www", "api", "new", "admin", "edit", "raw", "n", "app", "abuse", "report", "exists"]);
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const TEXT_MAX = 8 * 1024;
const URL_MAX = 2 * 1024;
const RATE_LIMIT = 10;

const ABUSE_EMAIL = "abuse@0g.hk";

const TTL_OPTIONS = {
  "1h": 3600,
  "1d": 86400,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
  "90d": 90 * 86400,
  "1y": 365 * 86400,
  "forever": 0,
};
const DEFAULT_TTL = "30d";

const REDIRECT_ALLOWLIST = [
  "github.com", "gist.github.com",
  "x.com", "twitter.com",
  "youtube.com", "youtu.be",
  "google.com",
  "wikipedia.org",
  "notion.so", "notion.site",
  "apple.com",
  "cloudflare.com",
  "openai.com", "anthropic.com", "claude.ai",
  "arxiv.org",
  "chen.rs",
  BASE_HOST,
];

// ---------- utils ----------

function randomName(len = 6) {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
  return s;
}

function genToken() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let b = "";
  for (let i = 0; i < buf.length; i++) b += String.fromCharCode(buf[i]);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const arr = new Uint8Array(buf);
  let b = "";
  for (let i = 0; i < arr.length; i++) b += String.fromCharCode(arr[i]);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function ctEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function isUrl(s) { return /^https?:\/\//i.test(s.trim()); }
function parseUrlSafe(s) { try { return new URL(s.trim()); } catch { return null; } }

function isAllowedTarget(u) {
  const p = parseUrlSafe(u);
  if (!p) return false;
  const h = p.hostname.toLowerCase();
  return REDIRECT_ALLOWLIST.some((d) => h === d || h.endsWith("." + d));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function rateLimit(env, ip) {
  const key = "rl:" + ip + ":" + Math.floor(Date.now() / 60000);
  const v = await env.NOTES.get(key);
  const n = v ? parseInt(v, 10) + 1 : 1;
  if (n > RATE_LIMIT) return false;
  await env.NOTES.put(key, String(n), { expirationTtl: 70 });
  return true;
}

function html(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: Object.assign({ "content-type": "text/html;charset=utf-8" }, extra),
  });
}

// ---------- shared HTML bits ----------

// Shared CSS. Mobile-first, CSS custom properties, 44px+ tap targets, 16px base
// font (prevents iOS focus-zoom), respects safe-area insets.
const COMMON_CSS = [
  ':root{color-scheme:light dark;--bg:#fafafa;--surface:#fff;--text:#111;--muted:#525252;--faint:#888;--border:#e5e5e5;--border-strong:#d4d4d4;--accent:#111;--accent-fg:#fff;--ok:#059669;--warn:#b45309;--warn-bg:#fef3c7;--warn-fg:#78350f;--warn-border:#fcd34d;--err:#dc2626;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}',
  '@media(prefers-color-scheme:dark){:root{--bg:#0a0a0a;--surface:#141414;--text:#ededed;--muted:#a3a3a3;--faint:#737373;--border:#262626;--border-strong:#3a3a3a;--accent:#fff;--accent-fg:#000;--warn-bg:#2a1f0a;--warn-fg:#fbbf24;--warn-border:#78350f}}',
  '*{box-sizing:border-box;margin:0;padding:0}',
  'html{-webkit-text-size-adjust:100%}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;background:var(--bg);color:var(--text);padding:clamp(1rem,4vw,2rem) clamp(.85rem,4vw,2rem);min-height:100vh;padding-bottom:max(clamp(1.25rem,4vw,2rem),env(safe-area-inset-bottom))}',
  '.wrap{max-width:640px;margin:0 auto}',
  '.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:clamp(1.1rem,4vw,1.75rem)}',
  'h1{font-size:clamp(1.1rem,3.2vw,1.3rem);font-weight:600;letter-spacing:-.01em;margin-bottom:.3rem}',
  '.hint{font-size:.92rem;color:var(--muted);margin-bottom:1.25rem;line-height:1.6}',
  'code{font-family:var(--mono);background:rgba(128,128,128,.14);padding:.05rem .32rem;border-radius:4px;font-size:.85em}',
  'label{display:block;font-size:.82rem;color:var(--muted);margin:0 0 .35rem;font-weight:500}',
  '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
  'input,textarea,select{width:100%;padding:.7rem .85rem;border:1px solid var(--border-strong);border-radius:8px;font-family:inherit;font-size:1rem;background:var(--surface);color:var(--text);min-height:44px}',
  'select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--faint) 50%),linear-gradient(135deg,var(--faint) 50%,transparent 50%);background-position:calc(100% - 18px) 52%,calc(100% - 13px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:2rem}',
  'input:focus,textarea:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}',
  'textarea{min-height:180px;font-family:var(--mono);font-size:.95rem;resize:vertical;line-height:1.55}',
  'button{padding:.8rem 1.25rem;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);cursor:pointer;font-size:1rem;font-weight:500;min-height:44px;font-family:inherit;-webkit-tap-highlight-color:transparent;transition:opacity .12s}',
  'button:active{transform:translateY(1px)}',
  '@media(hover:hover){button:hover{opacity:.88}}',
  'button.secondary{background:transparent;color:inherit;border:1px solid var(--border-strong);font-weight:400}',
  '@media(hover:hover){button.secondary:hover{background:rgba(128,128,128,.1)}}',
  'button[disabled]{opacity:.5;cursor:not-allowed}',
  '.foot{margin-top:1.5rem;text-align:center;font-size:.82rem;color:var(--faint)}',
  '.foot a{color:inherit;text-decoration:none;margin:0 .5rem;padding:.25rem 0;display:inline-block}',
  '.alert-warn{background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:8px;padding:.75rem 1rem;margin-bottom:1rem;color:var(--warn-fg);font-size:.9rem;line-height:1.55}',
  '.alert-warn a{color:inherit;text-decoration:underline}',
].join("\n");

function footerHtml() {
  return '<div class="foot"><a href="https://' + BASE_HOST + '/">+ 再创建</a> · <a href="https://github.com/catoncat/0g-hk">GitHub</a> · <a href="https://github.com/catoncat/0g-hk/blob/main/docs/API.md">API</a> · <a href="mailto:' + ABUSE_EMAIL + '?subject=Report%20' + BASE_HOST + '">举报滥用</a></div>';
}

// ---------- pages ----------

function editorPage(opts) {
  opts = opts || {};
  const prefillContent = opts.prefillContent || "";
  const prefillName = opts.prefillName || "";
  const prefillTtl = opts.prefillTtl || DEFAULT_TTL;
  const errorName = opts.errorName || "";
  const alertTop = opts.alertTop || "";
  const advOpen = (prefillName || errorName || (prefillTtl && prefillTtl !== DEFAULT_TTL)) ? ' open' : '';
  const ttlOpts = Object.keys(TTL_OPTIONS).map((k) => '<option' + (k === prefillTtl ? ' selected' : '') + '>' + k + '</option>').join('');

  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
'<meta name="theme-color" content="#fafafa" media="(prefers-color-scheme:light)">' +
'<meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme:dark)">' +
'<meta name="description" content="把一段文字或链接变成 xxx.0g.hk。无账号、一次 GET 完成。">' +
'<title>' + BASE_HOST + ' — 临时笔记 · 短链</title>\n' +
'<style>\n' + COMMON_CSS + '\n' +
'.brand{font-family:var(--mono);font-size:clamp(1.5rem,5.5vw,1.9rem);font-weight:600;letter-spacing:-.02em;margin-bottom:.4rem}\n' +
'.brand .dot{color:#10b981}\n' +
'.tagline{color:var(--muted);font-size:1rem;line-height:1.6;margin-bottom:1.5rem}\n' +
'.tagline code{font-size:.9em}\n' +
'.tagline a{color:inherit;text-decoration:underline;text-underline-offset:2px}\n' +
'.cta{display:flex;flex-direction:column;gap:.5rem;margin-top:1rem}\n' +
'.cta button{width:100%;min-height:50px;font-size:1.02rem}\n' +
'.type-hint{font-size:.8rem;color:var(--faint);font-family:var(--mono);text-align:center;min-height:1.2em;letter-spacing:.02em}\n' +
'details.adv{margin-top:1.25rem;border-top:1px solid var(--border);padding-top:1rem}\n' +
'details.adv>summary{cursor:pointer;list-style:none;font-size:.9rem;color:var(--muted);display:flex;align-items:center;gap:.4rem;user-select:none;-webkit-tap-highlight-color:transparent;padding:.25rem 0;min-height:32px}\n' +
'details.adv>summary::-webkit-details-marker{display:none}\n' +
'details.adv>summary::before{content:"+";display:inline-flex;width:1em;justify-content:center;font-family:var(--mono);color:var(--faint)}\n' +
'details.adv[open]>summary::before{content:"−"}\n' +
'.adv-body{margin-top:.9rem;display:grid;gap:.9rem;grid-template-columns:1fr}\n' +
'@media(min-width:560px){.adv-body{grid-template-columns:1fr 140px}}\n' +
'.row{display:flex;gap:.4rem;align-items:stretch}.row input{flex:1;min-width:0}\n' +
'.row .suffix{font-family:var(--mono);color:var(--faint);font-size:.9rem;display:flex;align-items:center;padding:0 .2rem;white-space:nowrap}\n' +
'.name-status{display:block;font-size:.78rem;margin-top:.35rem;min-height:1.1em;color:var(--faint);line-height:1.45}\n' +
'.name-status.ok{color:var(--ok)}.name-status.warn{color:var(--warn)}.name-status.err{color:var(--err)}\n' +
'input.err-border{border-color:var(--err)!important}\n' +
'.scenarios{margin-top:2rem}\n' +
'.scenarios-title{font-size:.72rem;color:var(--faint);text-transform:uppercase;letter-spacing:.12em;margin-bottom:.9rem;font-weight:600;padding-left:.2rem}\n' +
'.scn{display:grid;gap:.85rem;grid-template-columns:minmax(0,1fr)}\n' +
'@media(min-width:760px){.scn{grid-template-columns:repeat(3,minmax(0,1fr))}}\n' +
'.s-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:1rem;font-size:.88rem;line-height:1.55;display:flex;flex-direction:column;gap:.45rem;min-width:0}\n' +
'.s-head{display:flex;gap:.5rem;align-items:baseline}\n' +
'.s-emoji{font-size:1rem;line-height:1}\n' +
'.s-title{font-weight:600;color:var(--text);font-size:.92rem}\n' +
'.s-desc{color:var(--muted);font-size:.85rem;line-height:1.5}\n' +
'.s-card pre{font-family:var(--mono);font-size:.76rem;background:rgba(128,128,128,.1);padding:.55rem .65rem;border-radius:6px;color:var(--text);overflow-x:auto;white-space:pre;line-height:1.55;margin-top:auto}\n' +
'</style></head><body>\n' +
'<div class="wrap">\n' +
'<div class="card">\n' +
'<div class="brand">0g<span class="dot">.</span>hk</div>\n' +
'<div class="tagline">把一段文字或链接变成 <code>xxx.0g.hk</code>。<br>无账号、无表单。有 <a href="https://github.com/catoncat/0g-hk/blob/main/docs/API.md">JSON API</a>。</div>\n' +
(alertTop ? '<div class="alert-warn">' + alertTop + '</div>\n' : '') +
'<form onsubmit="return go(event)">\n' +
'<label for="c" class="sr">内容</label>' +
'<textarea id="c" required autofocus placeholder="粘贴一段文字，或 https://…">' + esc(prefillContent) + '</textarea>\n' +
'<div class="cta"><button type="submit" id="submitBtn">生成 →</button><span id="typeHint" class="type-hint"></span></div>\n' +
'<details class="adv"' + advOpen + '><summary>自定义名字 · 保留时长</summary>\n' +
'<div class="adv-body">\n' +
'<div><label for="n">自定义名字（可选）</label><div class="row"><input id="n" value="' + esc(prefillName) + '" autocomplete="off" inputmode="url" pattern="[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?" placeholder="例如 talk"' + (errorName ? ' class="err-border"' : '') + '><span class="suffix">.' + BASE_HOST + '</span></div><span id="ns" class="name-status' + (errorName ? ' err' : '') + '">' + esc(errorName) + '</span></div>\n' +
'<div><label for="ttl">保留时长</label><select id="ttl">' + ttlOpts + '</select></div>\n' +
'</div></details>\n' +
'</form>\n' +
'</div>\n' +
'<section class="scenarios" aria-label="典型用法">\n' +
'<div class="scenarios-title">三种典型用法</div>\n' +
'<div class="scn">\n' +
'<div class="s-card"><div class="s-head"><span class="s-emoji">📋</span><span class="s-title">分享临时文本</span></div><div class="s-desc">剪贴板→一个可分享的 URL。</div><pre>pbpaste | curl -sS --data-binary @- 0g.hk/</pre></div>\n' +
'<div class="s-card"><div class="s-head"><span class="s-emoji">🔗</span><span class="s-title">做个好记的短链</span></div><div class="s-desc">子域即资源，比随机哈希好记 10 倍。</div><pre>curl -d https://… \'0g.hk/?n=talk\'</pre></div>\n' +
'<div class="s-card"><div class="s-head"><span class="s-emoji">⚡</span><span class="s-title">脚本友好的 JSON</span></div><div class="s-desc">Accept: application/json 拿到 token 与元数据。</div><pre>curl -sH accept:application/json \\\n -d hi 0g.hk/ | jq .editUrl</pre></div>\n' +
'</div></section>\n' +
 footerHtml() + '\n' +
'</div>\n' +
'<script>\n' +
'var nInp=document.getElementById("n"),ns=document.getElementById("ns"),submitBtn=document.getElementById("submitBtn"),ta=document.getElementById("c"),th=document.getElementById("typeHint");\n' +
'var checkTimer=null,nameAvailable=null;\n' +
'function setStatus(msg,cls){ns.textContent=msg;ns.className="name-status "+(cls||"")}\n' +
'function updateCta(){var v=ta.value.trim();if(!v){submitBtn.textContent="生成 →";th.textContent="";return}if(/^https?:\\/\\//i.test(v)){submitBtn.textContent="生成短链 →";th.textContent="检测到 URL · 将做成 302 短链"}else{submitBtn.textContent="生成笔记页 →";th.textContent=v.length+" 字 · 将做成笔记页"}}\n' +
'ta.addEventListener("input",updateCta);updateCta();\n' +
'function checkName(){var v=nInp.value.trim().toLowerCase();if(!v){setStatus("","");nInp.classList.remove("err-border");nameAvailable=null;return}if(!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(v)){setStatus("格式：小写字母/数字/-，2–32 位，首尾非 -","err");nInp.classList.add("err-border");nameAvailable=false;return}setStatus("检查中…","pending");fetch("/exists?n="+encodeURIComponent(v)).then(function(r){return r.json()}).then(function(d){if(nInp.value.trim().toLowerCase()!==v)return;if(!d.valid){setStatus("不可用：保留名或格式无效","err");nInp.classList.add("err-border");nameAvailable=false}else if(d.exists){setStatus("已被占用。如是你本人创建的，请用当时的编辑链接。","warn");nInp.classList.remove("err-border");nameAvailable=false}else{setStatus("✓ 可用","ok");nInp.classList.remove("err-border");nameAvailable=true}}).catch(function(){setStatus("","")})}\n' +
'nInp.addEventListener("input",function(){clearTimeout(checkTimer);checkTimer=setTimeout(checkName,300)});\n' +
'if(nInp.value)checkName();\n' +
'function go(e){e.preventDefault();var nameVal=nInp.value.trim();if(nameVal&&nameAvailable===false){ns.className="name-status err";nInp.focus();return false}var c=ta.value;var t=document.getElementById("ttl").value;var p=new URLSearchParams();if(nameVal)p.set("n",nameVal);p.set("c",c);if(t&&t!=="' + DEFAULT_TTL + '")p.set("ttl",t);location.href="/?"+p.toString();return false}\n' +
'</script>\n' +
'</body></html>';
  return html(body);
}

function resultPage(name, content, mode, ttlKey, editToken) {
  // mode: "created" | "updated"
  const short = "https://" + name + "." + BASE_HOST;
  const editUrl = editToken ? (short + "/edit#t=" + editToken) : null;
  const link = isUrl(content);
  const typeBg = link ? "#e0f2fe" : "#fef3c7";
  const typeFg = link ? "#0369a1" : "#92400e";
  const allowed = link && isAllowedTarget(content);
  const typeLabel = link ? (allowed ? "302 直跳" : "302 需确认") : "笔记";
  const header = mode === "updated" ? "已更新" : "已创建";
  const headerColor = mode === "updated" ? "#059669" : "#888";
  const targetLine = link
    ? ('目标：<a href="' + esc(content.trim()) + '">' + esc(content.trim().slice(0, 120)) + '</a>')
    : ('内容长度：' + content.length + ' 字符');
  const ttlLine = ttlKey ? ('<br>保留：' + (ttlKey === 'forever' ? '永久' : ttlKey)) : '';
  const qrSrc = "https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=" + encodeURIComponent(short);

  const editBlock = editUrl ? (
    '<div class="edit-card">\n' +
    '<div class="edit-title">⚠️ 编辑链接只显示本次请立即复制保存</div>\n' +
    '<div class="edit-sub">拿到链接的人可修改此名字的内容。关掉本页就拿不回来了。</div>\n' +
    '<div class="url"><input id="eu" value="' + esc(editUrl) + '" readonly onclick="this.select()"><button class="secondary" onclick="copyEdit(this)">复制</button></div>\n' +
    '</div>\n'
  ) : '';

  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + header + ' · ' + esc(name) + '</title>\n' +
'<style>\n' + COMMON_CSS + '\n' +
'.card{max-width:560px}h1{font-size:.8rem;color:' + headerColor + ';font-weight:500;margin-bottom:1rem;text-transform:uppercase;letter-spacing:.08em;display:flex;gap:.5rem;align-items:center}\n' +
'.type{padding:.15rem .5rem;border-radius:4px;background:' + typeBg + ';color:' + typeFg + ';font-size:.7rem;font-weight:600}\n' +
'.url{display:flex;gap:.5rem;margin-bottom:1rem}\n' +
'.url input{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1rem;padding:.6rem .85rem;border:1px solid #ddd;border-radius:8px}\n' +
'.url button{padding:.6rem 1rem;font-size:.9rem}\n' +
'.edit-card{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:1rem 1.1rem;margin:1rem 0 1.25rem}\n' +
'.edit-card .edit-title{font-size:.9rem;font-weight:600;color:#92400e;margin-bottom:.25rem}\n' +
'.edit-card .edit-sub{font-size:.78rem;color:#78716c;margin-bottom:.7rem;line-height:1.5}\n' +
'@media(prefers-color-scheme:dark){.edit-card{background:#1e1a0f;border-color:#78350f}.edit-card .edit-title{color:#fbbf24}.edit-card .edit-sub{color:#a8a29e}}\n' +
'.meta{font-size:.85rem;color:#666;margin-top:1rem;line-height:1.8}.meta a{color:inherit}\n' +
'.qr{margin-top:1.5rem;display:flex;justify-content:center}.qr img{border-radius:8px;background:#fff;padding:8px}\n' +
'</style></head><body>\n' +
'<div class="card">\n' +
'<h1>' + header + ' <span class="type">' + typeLabel + '</span></h1>\n' +
'<div class="url"><input id="u" value="' + esc(short) + '" readonly onclick="this.select()"><button onclick="copyShort(this)">复制</button></div>\n' +
 editBlock +
'<div class="meta">访问：<a href="' + esc(short) + '">' + esc(short) + '</a><br>原文：<a href="' + esc(short) + '/raw">' + esc(short) + '/raw</a><br>' + targetLine + ttlLine + '</div>\n' +
'<div class="qr"><img alt="QR" src="' + esc(qrSrc) + '" width="160" height="160" loading="lazy"></div>\n' +
 footerHtml() + '\n' +
'</div>\n' +
'<script>function copyShort(b){navigator.clipboard.writeText(document.getElementById("u").value).then(function(){b.textContent="已复制";setTimeout(function(){b.textContent="复制"},1500)})}function copyEdit(b){navigator.clipboard.writeText(document.getElementById("eu").value).then(function(){b.textContent="已复制";setTimeout(function(){b.textContent="复制"},1500)})}</script>\n' +
'</body></html>';
  return html(body);
}

function notePage(sub, content) {
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(sub) + ' · ' + BASE_HOST + '</title>\n' +
'<style>:root{color-scheme:light dark}*{box-sizing:border-box;margin:0;padding:0}html{-webkit-text-size-adjust:100%}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:16px;padding:clamp(1rem,4vw,2rem) clamp(.85rem,4vw,2rem);padding-bottom:max(clamp(1rem,4vw,2rem),env(safe-area-inset-bottom));max-width:760px;margin:0 auto;line-height:1.6;background:#fafafa;color:#111}\n' +
'@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#eee}pre{background:#141414;border-color:#262626}header{border-color:#262626}.foot{color:#737373}}\n' +
'header{display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding-bottom:.75rem;margin-bottom:1.25rem;border-bottom:1px solid #e5e5e5;font-size:.85rem;color:#888}\n' +
'header a{color:inherit;text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;flex:1;min-width:0}\n' +
'pre{white-space:pre-wrap;word-wrap:break-word;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:clamp(1rem,3vw,1.25rem);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.95rem;line-height:1.6}\n' +
'button{padding:.5rem .85rem;min-height:36px;border:1px solid #ddd;border-radius:6px;background:transparent;cursor:pointer;font-size:.82rem;color:inherit;font-family:inherit;flex:0 0 auto;-webkit-tap-highlight-color:transparent}@media(hover:hover){button:hover{background:rgba(128,128,128,.12)}}\n' +
'.foot{margin-top:1.5rem;text-align:center;font-size:.8rem;color:#888}.foot a{color:inherit;text-decoration:none;margin:0 .5rem;padding:.2rem 0;display:inline-block}\n' +
'</style></head><body>\n' +
'<header><a href="/raw">' + esc(sub) + '.' + BASE_HOST + '</a>\n' +
'<button onclick="navigator.clipboard.writeText(document.getElementById(\'c\').innerText).then(()=>{this.textContent=\'已复制\';setTimeout(()=>this.textContent=\'复制\',1200)})">复制全文</button></header>\n' +
'<pre id="c">' + esc(content) + '</pre>\n' +
 footerHtml() + '\n' +
'</body></html>';
  return html(body);
}

function interstitialPage(sub, target) {
  const parsed = parseUrlSafe(target);
  const host = parsed ? parsed.hostname : target;
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>即将跳转 · ' + BASE_HOST + '</title>\n' +
'<meta name="robots" content="noindex">\n' +
'<style>:root{color-scheme:light dark}*{box-sizing:border-box;margin:0;padding:0}html{-webkit-text-size-adjust:100%}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:16px;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:clamp(1rem,4vw,2rem);padding-bottom:max(clamp(1rem,4vw,2rem),env(safe-area-inset-bottom));background:#fafafa;color:#111}\n' +
'@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#ededed}.card{background:#141414;border-color:#262626}.target{background:#1a1a1a;border-color:#333}.host{color:#fbbf24}.foot{color:#737373}}\n' +
'.card{max-width:560px;width:100%;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:clamp(1.25rem,4vw,2rem);text-align:center}\n' +
'h1{font-size:clamp(1rem,3vw,1.15rem);margin-bottom:.5rem;font-weight:600}\n' +
'.warn{font-size:.88rem;color:#92400e;margin-bottom:1rem;line-height:1.55}\n' +
'@media(prefers-color-scheme:dark){.warn{color:#fbbf24}}\n' +
'.host{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.05rem;font-weight:600;color:#b45309;word-break:break-all;line-height:1.4}\n' +
'.target{background:#f5f5f5;border:1px solid #e5e5e5;border-radius:8px;padding:.75rem 1rem;margin:1rem 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;text-align:left;word-break:break-all;line-height:1.5}\n' +
'a.btn{display:inline-block;margin-top:.5rem;padding:.85rem 1.75rem;min-height:48px;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-size:1rem;font-weight:500;-webkit-tap-highlight-color:transparent}\n' +
'@media(hover:hover){a.btn:hover{opacity:.88}}\n' +
'@media(prefers-color-scheme:dark){a.btn{background:#fff;color:#000}}\n' +
'.foot{margin-top:1.5rem;font-size:.8rem;color:#888}.foot a{color:inherit;text-decoration:none;margin:0 .5rem;padding:.2rem 0;display:inline-block}\n' +
'</style></head><body>\n' +
'<div class="card">\n' +
'<h1>即将离开 ' + BASE_HOST + '</h1>\n' +
'<div class="warn">此链接由用户创建，不在可信白名单。请确认目标域名：</div>\n' +
'<div class="host">' + esc(host) + '</div>\n' +
'<div class="target">' + esc(target) + '</div>\n' +
'<a class="btn" rel="noopener noreferrer nofollow" href="' + esc(target) + '">确认继续 →</a>\n' +
'<div class="foot"><a href="https://' + BASE_HOST + '/">返回首页</a> · <a href="mailto:' + ABUSE_EMAIL + '?subject=Report%20' + esc(sub) + '.' + BASE_HOST + '">举报此链接</a></div>\n' +
'</div></body></html>';
  return html(body);
}

function editNotePage(sub, ttlKey) {
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>编辑 ' + esc(sub) + ' · ' + BASE_HOST + '</title>\n' +
'<meta name="robots" content="noindex">\n' +
'<style>\n' + COMMON_CSS + '\n' +
'.meta{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;color:#888;margin-bottom:1rem}\n' +
'.meta strong{color:#111}\n' +
'@media(prefers-color-scheme:dark){.meta strong{color:#eee}}\n' +
'.row{display:flex;gap:.75rem;align-items:center;margin-top:1.25rem}\n' +
'.row button{flex:0 0 auto}\n' +
'.row .status{flex:1;font-size:.85rem;color:#888;min-height:1.2em}\n' +
'.status.ok{color:#059669}.status.err{color:#dc2626}\n' +
'.error-box{background:#fee2e2;border:1px solid #fca5a5;color:#991b1b;border-radius:8px;padding:1rem;font-size:.9rem;line-height:1.5}\n' +
'@media(prefers-color-scheme:dark){.error-box{background:#2a0e0e;border-color:#7f1d1d;color:#fca5a5}}\n' +
'</style></head><body>\n' +
'<div class="card">\n' +
'<h1>编辑笔记</h1>\n' +
'<div class="meta"><strong>' + esc(sub) + '.' + BASE_HOST + '</strong> · 保留 ' + (ttlKey === 'forever' ? '永久' : esc(ttlKey)) + '</div>\n' +
'<div id="wrap" style="display:none">\n' +
'<textarea id="c" autofocus></textarea>\n' +
'<div class="row"><button id="s" onclick="save()">保存</button><span id="st" class="status"></span></div>\n' +
'</div>\n' +
'<div id="err" class="error-box" style="display:none"></div>\n' +
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
  return html(body, 200, { "cache-control": "no-store" });
}

function notFoundPage(sub) {
  const body = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>404</title>' +
'<style>body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;font-size:16px;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:clamp(1rem,4vw,2rem);color:#666;background:#fafafa;text-align:center;line-height:1.6}@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#a3a3a3}}a{color:inherit;padding:.25rem .1rem;display:inline-block}</style>' +
'</head><body><div><h1 style="margin:0;font-size:3rem">404</h1><p><code>' + esc(sub) + '</code> 不存在，<a href="https://' + BASE_HOST + '/">去创建 →</a></p></div></body></html>';
  return html(body, 404);
}

// ---------- api helpers ----------

const API_VERSION = 1;

function wantsJson(req, url) {
  const f = (url.searchParams.get("format") || "").toLowerCase();
  if (f === "json") return true;
  if (f === "html") return false;
  const accept = (req.headers.get("accept") || "").toLowerCase();
  // Opt-in: Accept includes application/json AND not text/html.
  // Browsers always send text/html so they stay on HTML.
  return accept.includes("application/json") && !accept.includes("text/html");
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({
      "content-type": "application/json;charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    }, extraHeaders),
  });
}

function jsonError(code, message, status, extra = {}) {
  return jsonResponse({ ok: false, error: Object.assign({ code, message }, extra) }, status);
}

function replyError(req, url, code, message, status, extra = {}) {
  if (wantsJson(req, url)) return jsonError(code, message, status, extra);
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8" },
  });
}

function shortUrlFor(name) { return "https://" + name + "." + BASE_HOST; }

function expiresAtIso(ttlKey, createdAtMs) {
  const ttlSec = TTL_OPTIONS[ttlKey];
  if (!ttlSec || ttlSec <= 0 || !createdAtMs) return null;
  return new Date(createdAtMs + ttlSec * 1000).toISOString();
}

function noteMetaHeaders(o) {
  const short = shortUrlFor(o.name);
  const h = {
    "x-name": o.name,
    "x-short-url": short,
    "x-raw-url": short + "/raw",
    "x-kind": o.kind,
    "x-ttl": o.ttlKey,
    "x-expires-at": expiresAtIso(o.ttlKey, o.createdAtMs) || "never",
    "access-control-expose-headers":
      "x-name,x-short-url,x-raw-url,x-kind,x-ttl,x-expires-at,x-target,x-edit-token,x-edit-url,x-created-at",
  };
  if (o.createdAtMs) h["x-created-at"] = new Date(o.createdAtMs).toISOString();
  if (o.target) h["x-target"] = o.target;
  if (o.editToken) {
    h["x-edit-token"] = o.editToken;
    h["x-edit-url"] = short + "/edit#t=" + o.editToken;
  }
  return h;
}

async function readBody(req) {
  if (req.method !== "POST" && req.method !== "PUT") return { ok: true, body: {} };
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (ctype.startsWith("application/json")) {
      const j = await req.json();
      if (!j || typeof j !== "object") return { ok: false, err: "Invalid JSON body" };
      return { ok: true, body: {
        content: j.content != null ? String(j.content) : (j.c != null ? String(j.c) : ""),
        name: j.name != null ? String(j.name) : (j.n != null ? String(j.n) : ""),
        ttl: j.ttl != null ? String(j.ttl) : "",
        token: j.token != null ? String(j.token) : (j.edit != null ? String(j.edit) : ""),
      }};
    }
    if (ctype.startsWith("application/x-www-form-urlencoded") || ctype.startsWith("multipart/form-data")) {
      const fd = await req.formData();
      const g = (k) => fd.get(k) != null ? String(fd.get(k)) : "";
      return { ok: true, body: {
        content: g("c") || g("content"),
        name: g("n") || g("name"),
        ttl: g("ttl"),
        token: g("edit") || g("token"),
      }};
    }
    // text/plain or unknown: body IS the content
    const text = await req.text();
    return { ok: true, body: { content: text, name: "", ttl: "", token: "" } };
  } catch (e) {
    return { ok: false, err: "Failed to parse body: " + String(e && e.message || e) };
  }
}

// ---------- handlers ----------

async function handleExists(env, url) {
  const n = (url.searchParams.get("n") || "").toLowerCase().trim();
  if (!n) return jsonResponse({ valid: false, reason: "empty" });
  if (!NAME_RE.test(n) || RESERVED.has(n)) return jsonResponse({ valid: false, reason: "invalid" });
  const existing = await env.NOTES.get("n:" + n);
  return jsonResponse({ valid: true, exists: existing !== null });
}

async function handleCreate(req, env, url) {
  const bodyRes = await readBody(req);
  if (!bodyRes.ok) return replyError(req, url, "bad_body", bodyRes.err, 400);
  const bp = bodyRes.body || {};

  // Body wins when set; query string is fallback.
  let name = (bp.name || url.searchParams.get("n") || "").toLowerCase().trim();
  const content = bp.content || url.searchParams.get("c") || "";
  if (!content) {
    if (wantsJson(req, url)) return jsonError("missing_content", "content is required (body or ?c=)", 400);
    return editorPage();
  }

  const urlMode = isUrl(content);
  if (urlMode && content.length > URL_MAX) return replyError(req, url, "url_too_long", "URL too long (max " + URL_MAX + ")", 413, { maxLength: URL_MAX });
  if (!urlMode && content.length > TEXT_MAX) return replyError(req, url, "text_too_long", "Text too long (max " + TEXT_MAX + ")", 413, { maxLength: TEXT_MAX });
  if (urlMode && !parseUrlSafe(content)) return replyError(req, url, "malformed_url", "Malformed URL", 400);

  if (name) {
    if (!NAME_RE.test(name)) return replyError(req, url, "invalid_name", "Invalid name (need [a-z0-9-]{2,32}, alnum ends)", 400);
    if (RESERVED.has(name)) return replyError(req, url, "reserved_name", "Reserved name", 400, { name });
  }

  const ttlKey = (bp.ttl || url.searchParams.get("ttl") || DEFAULT_TTL).toLowerCase();
  if (!(ttlKey in TTL_OPTIONS)) {
    return replyError(req, url, "invalid_ttl", "Invalid ttl (use " + Object.keys(TTL_OPTIONS).join("/") + ")", 400, { allowed: Object.keys(TTL_OPTIONS) });
  }
  const ttlSec = TTL_OPTIONS[ttlKey];

  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (!(await rateLimit(env, ip))) {
    return replyError(req, url, "rate_limited", "Rate limit exceeded (" + RATE_LIMIT + "/min)", 429, { limit: RATE_LIMIT, windowSeconds: 60 });
  }

  if (!name) {
    for (let i = 0; i < 6; i++) {
      const cand = randomName(6);
      if (RESERVED.has(cand)) continue;
      if (!(await env.NOTES.get("n:" + cand))) { name = cand; break; }
    }
    if (!name) return replyError(req, url, "alloc_failed", "Could not allocate name", 500);
  }

  const key = "n:" + name;
  const existing = await env.NOTES.get(key);
  if (existing !== null) {
    if (wantsJson(req, url)) return jsonError("name_taken", "Name already taken", 409, { name });
    // HTML: 同名冲突 → 编辑器内联错误，保留内容
    return editorPage({
      prefillContent: content,
      prefillName: name,
      prefillTtl: ttlKey,
      errorName: "“" + name + "” 已被占用，换一个名字。如是你本人创建的，请直接使用当时的编辑链接。",
    });
  }

  const token = genToken();
  const tokenHash = await sha256Base64Url(token);
  const createdAtMs = Date.now();
  const putOpts = ttlSec > 0 ? { expirationTtl: ttlSec } : {};
  const meta = JSON.stringify({ v: 1, h: tokenHash, t: ttlKey, ct: createdAtMs });
  await env.NOTES.put(key, content, putOpts);
  await env.NOTES.put("m:" + name, meta, putOpts);

  const kind = urlMode ? "url" : "text";
  const target = urlMode ? content.trim() : null;
  const mh = noteMetaHeaders({ name, ttlKey, createdAtMs, kind, target, editToken: token });

  if (wantsJson(req, url)) {
    return jsonResponse({
      ok: true,
      apiVersion: API_VERSION,
      name,
      kind,
      shortUrl: shortUrlFor(name),
      rawUrl: shortUrlFor(name) + "/raw",
      editToken: token,
      editUrl: shortUrlFor(name) + "/edit#t=" + token,
      ttl: ttlKey,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: expiresAtIso(ttlKey, createdAtMs),
      target,
      contentLength: content.length,
    }, 201, mh);
  }

  const r = resultPage(name, content, "created", ttlKey, token);
  for (const k in mh) r.headers.set(k, mh[k]);
  return r;
}

async function handleEdit(req, env, sub, url) {
  const bodyRes = await readBody(req);
  if (!bodyRes.ok) return replyError(req, url, "bad_body", bodyRes.err, 400);
  const bp = bodyRes.body || {};

  const token = bp.token || url.searchParams.get("edit") || "";
  const content = bp.content || url.searchParams.get("c") || "";
  if (!token) return replyError(req, url, "missing_token", "Missing edit token", 400);
  if (!content) return replyError(req, url, "missing_content", "Missing content", 400);

  const urlMode = isUrl(content);
  if (urlMode && content.length > URL_MAX) return replyError(req, url, "url_too_long", "URL too long", 413, { maxLength: URL_MAX });
  if (!urlMode && content.length > TEXT_MAX) return replyError(req, url, "text_too_long", "Text too long", 413, { maxLength: TEXT_MAX });
  if (urlMode && !parseUrlSafe(content)) return replyError(req, url, "malformed_url", "Malformed URL", 400);

  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (!(await rateLimit(env, ip))) {
    return replyError(req, url, "rate_limited", "Rate limit exceeded (" + RATE_LIMIT + "/min)", 429, { limit: RATE_LIMIT, windowSeconds: 60 });
  }

  const metaRaw = await env.NOTES.get("m:" + sub);
  if (!metaRaw) return replyError(req, url, "not_editable", "Not editable", 403);
  let meta;
  try { meta = JSON.parse(metaRaw); } catch { return replyError(req, url, "corrupt_meta", "Corrupt meta", 500); }
  const tokenHash = await sha256Base64Url(token);
  if (!ctEq(tokenHash, meta.h || "")) return replyError(req, url, "invalid_token", "Invalid edit token", 403);

  const ttlKey = TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL;
  const ttlSec = TTL_OPTIONS[ttlKey];
  const putOpts = ttlSec > 0 ? { expirationTtl: ttlSec } : {};
  await env.NOTES.put("n:" + sub, content, putOpts);
  await env.NOTES.put("m:" + sub, metaRaw, putOpts);

  const kind = urlMode ? "url" : "text";
  const target = urlMode ? content.trim() : null;
  const createdAtMs = meta.ct || Date.now();
  const mh = noteMetaHeaders({ name: sub, ttlKey, createdAtMs, kind, target });

  if (wantsJson(req, url)) {
    return jsonResponse({
      ok: true,
      apiVersion: API_VERSION,
      name: sub,
      kind,
      shortUrl: shortUrlFor(sub),
      rawUrl: shortUrlFor(sub) + "/raw",
      ttl: ttlKey,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: expiresAtIso(ttlKey, createdAtMs),
      target,
      contentLength: content.length,
    }, 200, mh);
  }

  const r = resultPage(sub, content, "updated", ttlKey, null);
  for (const k in mh) r.headers.set(k, mh[k]);
  return r;
}

async function handleSubdomain(req, env, host, url) {
  const pathname = url.pathname;
  const sub = host.slice(0, -(BASE_HOST.length + 1));
  if (!NAME_RE.test(sub) || RESERVED.has(sub)) {
    if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404, { name: sub });
    return notFoundPage(sub);
  }

  // Edit via query param OR POST/PUT body
  if (url.searchParams.has("edit") || req.method === "POST" || req.method === "PUT") {
    return handleEdit(req, env, sub, url);
  }

  if (pathname === "/edit") {
    const metaRaw = await env.NOTES.get("m:" + sub);
    const existing = await env.NOTES.get("n:" + sub);
    if (existing === null) {
      if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404, { name: sub });
      return notFoundPage(sub);
    }
    let meta = {};
    try { meta = metaRaw ? JSON.parse(metaRaw) : {}; } catch {}
    const ttlKey = TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL;
    return editNotePage(sub, ttlKey);
  }

  const content = await env.NOTES.get("n:" + sub);
  if (content === null) {
    if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404, { name: sub });
    return notFoundPage(sub);
  }

  const metaRaw = await env.NOTES.get("m:" + sub);
  let meta = {};
  try { meta = metaRaw ? JSON.parse(metaRaw) : {}; } catch {}
  const ttlKey = TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL;
  const createdAtMs = meta.ct || 0;
  const urlMode = isUrl(content);
  const kind = urlMode ? "url" : "text";
  const target = urlMode ? content.trim() : null;
  const mh = noteMetaHeaders({ name: sub, ttlKey, createdAtMs, kind, target });

  if (pathname === "/raw") {
    return new Response(content, {
      headers: Object.assign({
        "content-type": "text/plain;charset=utf-8",
        "cache-control": "public, max-age=60",
      }, mh),
    });
  }

  if (wantsJson(req, url)) {
    return jsonResponse({
      ok: true,
      apiVersion: API_VERSION,
      name: sub,
      kind,
      shortUrl: shortUrlFor(sub),
      rawUrl: shortUrlFor(sub) + "/raw",
      content,
      target,
      ttl: ttlKey,
      createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
      expiresAt: expiresAtIso(ttlKey, createdAtMs),
      contentLength: content.length,
    }, 200, mh);
  }

  if (urlMode) {
    const parsed = parseUrlSafe(content);
    if (!parsed) return notePage(sub, content);
    const bypass = url.searchParams.get("go") === "1";
    if (bypass || isAllowedTarget(target)) {
      return new Response(null, {
        status: 302,
        headers: Object.assign({ location: target }, mh),
      });
    }
    return interstitialPage(sub, target);
  }
  return notePage(sub, content);
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
      "access-control-allow-headers": "content-type, accept",
      "access-control-max-age": "86400",
    },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();

    if (req.method === "OPTIONS") return corsPreflight();

    if (host === BASE_HOST) {
      if (url.pathname === "/exists") return handleExists(env, url);
      if (url.pathname === "/" || url.pathname === "") {
        if (req.method === "POST" || req.method === "PUT" ||
            url.searchParams.has("c") || url.searchParams.has("n")) {
          return handleCreate(req, env, url);
        }
        return editorPage();
      }
      if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404);
      return new Response("Not found", { status: 404 });
    }
    if (host.endsWith("." + BASE_HOST)) return handleSubdomain(req, env, host, url);

    if (wantsJson(req, url)) return jsonError("not_found", "Not found", 404);
    return new Response("Not found", { status: 404 });
  },
};
