// 0g.hk — 临时笔记 + 302 短链
// GET /                                 -> 编辑器
// GET /exists?n=<name>                   -> JSON {valid, exists}（前端异步校验）
// GET /?c=...&n=...&ttl=...              -> 创建（同名冲突 → 编辑器+内联错误）
// GET <name>.0g.hk                       -> 白名单 302 / 跳转中间页 / 笔记页
// GET <name>.0g.hk/?go=1                 -> 绕过跳转中间页
// GET <name>.0g.hk/?edit=<tk>&c=<new>    -> 以 token 覆盖同名内容
// GET <name>.0g.hk/raw                   -> 原文
// GET <name>.0g.hk/edit                  -> 编辑器（从 #t= fragment 读 token）

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

const COMMON_CSS = [
  ':root{color-scheme:light dark}',
  '*{box-sizing:border-box;margin:0}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;background:#fafafa}',
  '@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#eee}.card{background:#161616;border-color:#333}input,textarea,select{background:#222;color:#eee;border-color:#444}.hint,.meta,.foot{color:#999}.meta a{color:#eee}.target,.edit-card{background:#1a1a1a}}',
  '.card{max-width:640px;width:100%;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:2rem;box-shadow:0 4px 20px rgba(0,0,0,.04)}',
  'h1{font-size:1.25rem;margin-bottom:.3rem}',
  '.hint{font-size:.85rem;color:#666;margin-bottom:1.5rem;line-height:1.7}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(128,128,128,.12);padding:.05rem .3rem;border-radius:3px;font-size:.82rem}',
  'label{display:block;font-size:.85rem;color:#666;margin:1rem 0 .4rem}',
  'input,textarea,select{width:100%;padding:.6rem .8rem;border:1px solid #ddd;border-radius:8px;font-family:inherit;font-size:.95rem}',
  'textarea{min-height:220px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;line-height:1.5}',
  'button{padding:.75rem 1.5rem;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer;font-size:.95rem;font-weight:500}',
  'button:hover{background:#333}',
  '@media(prefers-color-scheme:dark){button{background:#fff;color:#000}button:hover{background:#ddd}}',
  'button.secondary{background:transparent;color:inherit;border:1px solid #ddd;font-weight:400}',
  'button.secondary:hover{background:rgba(128,128,128,.12)}',
  '.foot{margin-top:1.5rem;text-align:center;font-size:.8rem;color:#888}.foot a{color:inherit;text-decoration:none;margin:0 .3rem}',
  '.alert-warn{background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:.75rem 1rem;margin-bottom:1rem;color:#78350f;font-size:.88rem;line-height:1.55}',
  '.alert-warn a{color:#78350f;text-decoration:underline}',
  '@media(prefers-color-scheme:dark){.alert-warn{background:#2a1f0a;border-color:#78350f;color:#fbbf24}.alert-warn a{color:#fbbf24}}',
].join("\n");

function footerHtml() {
  return '<div class="foot"><a href="https://' + BASE_HOST + '/">+ 再创建</a> · <a href="mailto:' + ABUSE_EMAIL + '?subject=Report%20' + BASE_HOST + '">举报滥用</a></div>';
}

// ---------- pages ----------

function editorPage(opts) {
  opts = opts || {};
  const prefillContent = opts.prefillContent || "";
  const prefillName = opts.prefillName || "";
  const prefillTtl = opts.prefillTtl || DEFAULT_TTL;
  const errorName = opts.errorName || "";
  const alertTop = opts.alertTop || "";
  const ttlOpts = Object.keys(TTL_OPTIONS).map((k) => '<option' + (k === prefillTtl ? ' selected' : '') + '>' + k + '</option>').join('');

  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + BASE_HOST + ' — 临时笔记 / 短链</title>\n' +
'<style>\n' + COMMON_CSS + '\n' +
'.row{display:flex;gap:.5rem;align-items:center}.row input{flex:1}.row .suffix{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#888;font-size:.9rem}\n' +
'.cols{display:grid;grid-template-columns:1fr 140px;gap:.75rem}\n' +
'form>button{margin-top:1.25rem}\n' +
'.name-status{display:block;font-size:.78rem;margin-top:.3rem;min-height:1.1em;color:#888}\n' +
'.name-status.ok{color:#059669}\n' +
'.name-status.warn{color:#b45309}\n' +
'.name-status.err{color:#dc2626}\n' +
'.name-status.pending{color:#999}\n' +
'input.err-border{border-color:#dc2626!important}\n' +
'</style></head><body>\n' +
'<div class="card">\n' +
'<h1>临时笔记 / 短链</h1>\n' +
'<div class="hint">贴一段文字 → 笔记页<br>贴一个 <code>http(s)://</code> 链接 → 302 短链（非白名单需确认页）<br>默认 30 天后过期。创建后会给你一个 <strong>一次性编辑链接</strong>，保存它可以日后修改同名内容。</div>\n' +
(alertTop ? '<div class="alert-warn">' + alertTop + '</div>\n' : '') +
'<form onsubmit="return go(event)">\n' +
'<div class="cols">\n' +
'<div><label>自定义名字（可选）</label><div class="row"><input id="n" value="' + esc(prefillName) + '" autocomplete="off" pattern="[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?" placeholder="例如 abc"' + (errorName ? ' class="err-border"' : '') + '><span class="suffix">.' + BASE_HOST + '</span></div><span id="ns" class="name-status' + (errorName ? ' err' : '') + '">' + esc(errorName) + '</span></div>\n' +
'<div><label>保留</label><select id="ttl">' + ttlOpts + '</select></div>\n' +
'</div>\n' +
'<label>内容</label>\n' +
'<textarea id="c" required autofocus placeholder="文字 / https://...">' + esc(prefillContent) + '</textarea>\n' +
'<button type="submit" id="submitBtn">生成 →</button>\n' +
'</form>\n' + footerHtml() + '\n' +
'</div>\n' +
'<script>\n' +
'var nInp=document.getElementById("n"),ns=document.getElementById("ns"),submitBtn=document.getElementById("submitBtn");\n' +
'var checkTimer=null,lastChecked="",nameAvailable=null;\n' +
'function setStatus(msg,cls){ns.textContent=msg;ns.className="name-status "+(cls||"")}\n' +
'function checkName(){var v=nInp.value.trim().toLowerCase();if(!v){setStatus("","");nInp.classList.remove("err-border");nameAvailable=null;return}if(!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(v)){setStatus("格式无效：小写字母/数字/-，2-32 位，首尾非 -","err");nInp.classList.add("err-border");nameAvailable=false;return}setStatus("检查中…","pending");lastChecked=v;fetch("/exists?n="+encodeURIComponent(v)).then(function(r){return r.json()}).then(function(d){if(nInp.value.trim().toLowerCase()!==v)return;if(!d.valid){setStatus("不可用：保留名或格式无效","err");nInp.classList.add("err-border");nameAvailable=false}else if(d.exists){setStatus("已被占用。如是你本人创建的，请使用当时拿到的编辑链接。","warn");nInp.classList.remove("err-border");nameAvailable=false}else{setStatus("✓ 可用","ok");nInp.classList.remove("err-border");nameAvailable=true}}).catch(function(){setStatus("","")})}\n' +
'nInp.addEventListener("input",function(){clearTimeout(checkTimer);checkTimer=setTimeout(checkName,300)});\n' +
'if(nInp.value)checkName();\n' +
'function go(e){e.preventDefault();var nameVal=nInp.value.trim();if(nameVal&&nameAvailable===false){ns.className="name-status err";nInp.focus();return false}var c=document.getElementById("c").value;var t=document.getElementById("ttl").value;var p=new URLSearchParams();if(nameVal)p.set("n",nameVal);p.set("c",c);if(t&&t!=="' + DEFAULT_TTL + '")p.set("ttl",t);location.href="/?"+p.toString();return false}\n' +
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
'<style>:root{color-scheme:light dark}*{box-sizing:border-box;margin:0}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;padding:2rem;max-width:760px;margin:0 auto;line-height:1.6;background:#fafafa;color:#111}\n' +
'@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#eee}pre{background:#161616;border-color:#333}header{border-color:#333}.foot{color:#777}}\n' +
'header{display:flex;justify-content:space-between;align-items:center;padding-bottom:.75rem;margin-bottom:1.5rem;border-bottom:1px solid #e5e5e5;font-size:.85rem;color:#888}\n' +
'header a{color:inherit;text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}\n' +
'pre{white-space:pre-wrap;word-wrap:break-word;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:1.25rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.95rem;line-height:1.55}\n' +
'button{padding:.35rem .75rem;border:1px solid #ddd;border-radius:6px;background:transparent;cursor:pointer;font-size:.8rem;color:inherit}button:hover{background:rgba(128,128,128,.12)}\n' +
'.foot{margin-top:1.5rem;text-align:center;font-size:.8rem;color:#888}.foot a{color:inherit;text-decoration:none;margin:0 .3rem}\n' +
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
'<style>:root{color-scheme:light dark}*{box-sizing:border-box;margin:0}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;background:#fafafa}\n' +
'@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#eee}.card{background:#161616;border-color:#333}.target{background:#222;border-color:#444}.host{color:#fcd34d}.foot{color:#777}}\n' +
'.card{max-width:560px;width:100%;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:2rem;box-shadow:0 4px 20px rgba(0,0,0,.04);text-align:center}\n' +
'h1{font-size:1.1rem;margin-bottom:.5rem}\n' +
'.warn{font-size:.85rem;color:#92400e;margin-bottom:1rem}\n' +
'.host{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.1rem;font-weight:600;color:#b45309;word-break:break-all}\n' +
'.target{background:#f5f5f5;border:1px solid #e5e5e5;border-radius:8px;padding:.75rem 1rem;margin:1rem 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;text-align:left;word-break:break-all;line-height:1.5}\n' +
'a.btn{display:inline-block;margin-top:.5rem;padding:.7rem 1.5rem;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-size:.95rem}\n' +
'a.btn:hover{background:#333}\n' +
'@media(prefers-color-scheme:dark){a.btn{background:#fff;color:#000}a.btn:hover{background:#ddd}}\n' +
'.foot{margin-top:1.5rem;font-size:.8rem;color:#888}.foot a{color:inherit;text-decoration:none;margin:0 .3rem}\n' +
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
'<style>body{font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#666;background:#fafafa;text-align:center}@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#aaa}}a{color:inherit}</style>' +
'</head><body><div><h1 style="margin:0;font-size:3rem">404</h1><p><code>' + esc(sub) + '</code> 不存在，<a href="https://' + BASE_HOST + '/">去创建 →</a></p></div></body></html>';
  return html(body, 404);
}

// ---------- handlers ----------

async function handleExists(env, url) {
  const n = (url.searchParams.get("n") || "").toLowerCase().trim();
  const json = (obj) => new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json;charset=utf-8", "cache-control": "no-store" },
  });
  if (!n) return json({ valid: false, reason: "empty" });
  if (!NAME_RE.test(n) || RESERVED.has(n)) return json({ valid: false, reason: "invalid" });
  const existing = await env.NOTES.get("n:" + n);
  return json({ valid: true, exists: existing !== null });
}

async function handleCreate(req, env, url) {
  let name = (url.searchParams.get("n") || "").toLowerCase().trim();
  const content = url.searchParams.get("c") || "";
  if (!content) return editorPage();

  const urlMode = isUrl(content);
  if (urlMode && content.length > URL_MAX) return new Response("URL too long", { status: 413 });
  if (!urlMode && content.length > TEXT_MAX) return new Response("Text too long", { status: 413 });
  if (urlMode && !parseUrlSafe(content)) return new Response("Malformed URL", { status: 400 });

  if (name) {
    if (!NAME_RE.test(name)) return new Response("Invalid name (need [a-z0-9-]{2,32}, alnum ends)", { status: 400 });
    if (RESERVED.has(name)) return new Response("Reserved name", { status: 400 });
  }

  const ttlKey = (url.searchParams.get("ttl") || DEFAULT_TTL).toLowerCase();
  if (!(ttlKey in TTL_OPTIONS)) {
    return new Response("Invalid ttl (use " + Object.keys(TTL_OPTIONS).join("/") + ")", { status: 400 });
  }
  const ttlSec = TTL_OPTIONS[ttlKey];

  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (!(await rateLimit(env, ip))) return new Response("Rate limit exceeded (10/min)", { status: 429 });

  if (!name) {
    for (let i = 0; i < 6; i++) {
      const cand = randomName(6);
      if (RESERVED.has(cand)) continue;
      if (!(await env.NOTES.get("n:" + cand))) { name = cand; break; }
    }
    if (!name) return new Response("Could not allocate name", { status: 500 });
  }

  const key = "n:" + name;
  const existing = await env.NOTES.get(key);
  if (existing !== null) {
    // 同名冲突 → 返回编辑器与内联错误，保留用户刚刚输入的内容
    return editorPage({
      prefillContent: content,
      prefillName: name,
      prefillTtl: ttlKey,
      errorName: "“" + name + "” 已被占用，换一个名字。如是你本人创建的，请直接使用当时的编辑链接。",
    });
  }

  const token = genToken();
  const tokenHash = await sha256Base64Url(token);
  const putOpts = ttlSec > 0 ? { expirationTtl: ttlSec } : {};
  const meta = JSON.stringify({ v: 1, h: tokenHash, t: ttlKey, ct: Date.now() });
  await env.NOTES.put(key, content, putOpts);
  await env.NOTES.put("m:" + name, meta, putOpts);
  return resultPage(name, content, "created", ttlKey, token);
}

async function handleEdit(req, env, sub, url) {
  const token = url.searchParams.get("edit") || "";
  const content = url.searchParams.get("c") || "";
  if (!token) return new Response("Missing edit token", { status: 400 });
  if (!content) return new Response("Missing content", { status: 400 });
  const urlMode = isUrl(content);
  if (urlMode && content.length > URL_MAX) return new Response("URL too long", { status: 413 });
  if (!urlMode && content.length > TEXT_MAX) return new Response("Text too long", { status: 413 });
  if (urlMode && !parseUrlSafe(content)) return new Response("Malformed URL", { status: 400 });

  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (!(await rateLimit(env, ip))) return new Response("Rate limit exceeded (10/min)", { status: 429 });

  const metaRaw = await env.NOTES.get("m:" + sub);
  if (!metaRaw) return new Response("Not editable", { status: 403 });
  let meta;
  try { meta = JSON.parse(metaRaw); } catch { return new Response("Corrupt meta", { status: 500 }); }
  const tokenHash = await sha256Base64Url(token);
  if (!ctEq(tokenHash, meta.h || "")) return new Response("Invalid edit token", { status: 403 });

  const ttlKey = TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL;
  const ttlSec = TTL_OPTIONS[ttlKey];
  const putOpts = ttlSec > 0 ? { expirationTtl: ttlSec } : {};
  await env.NOTES.put("n:" + sub, content, putOpts);
  await env.NOTES.put("m:" + sub, metaRaw, putOpts);
  return resultPage(sub, content, "updated", ttlKey, null);
}

async function handleSubdomain(req, env, host, url) {
  const pathname = url.pathname;
  const sub = host.slice(0, -(BASE_HOST.length + 1));
  if (!NAME_RE.test(sub) || RESERVED.has(sub)) return notFoundPage(sub);

  if (url.searchParams.has("edit")) return handleEdit(req, env, sub, url);

  if (pathname === "/edit") {
    const metaRaw = await env.NOTES.get("m:" + sub);
    const existing = await env.NOTES.get("n:" + sub);
    if (existing === null) return notFoundPage(sub);
    let meta = {};
    try { meta = metaRaw ? JSON.parse(metaRaw) : {}; } catch {}
    const ttlKey = TTL_OPTIONS[meta.t] !== undefined ? meta.t : DEFAULT_TTL;
    return editNotePage(sub, ttlKey);
  }

  const content = await env.NOTES.get("n:" + sub);
  if (content === null) return notFoundPage(sub);

  if (pathname === "/raw") {
    return new Response(content, {
      headers: {
        "content-type": "text/plain;charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=60",
      },
    });
  }

  if (isUrl(content)) {
    const parsed = parseUrlSafe(content);
    if (!parsed) return notePage(sub, content);
    const target = parsed.toString();
    const bypass = url.searchParams.get("go") === "1";
    if (bypass || isAllowedTarget(target)) return Response.redirect(target, 302);
    return interstitialPage(sub, target);
  }
  return notePage(sub, content);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    if (host === BASE_HOST) {
      if (url.pathname === "/exists") return handleExists(env, url);
      if (url.pathname === "/" || url.pathname === "") {
        if (url.searchParams.has("c") || url.searchParams.has("n")) return handleCreate(req, env, url);
        return editorPage();
      }
      return new Response("Not found", { status: 404 });
    }
    if (host.endsWith("." + BASE_HOST)) return handleSubdomain(req, env, host, url);
    return new Response("Not found", { status: 404 });
  },
};
