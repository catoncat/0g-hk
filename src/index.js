// n.chen.rs — 临时笔记 + 302 短链
// GET /                          -> 编辑器
// GET /?c=...&n=...               -> 创建（n 可选，同名不覆盖）
// GET <name>.n.chen.rs            -> 302 或笔记页
// GET <name>.n.chen.rs/raw        -> 原文

const BASE_HOST = "0g.hk";
const RESERVED = new Set(["www", "api", "new", "admin", "edit", "raw", "n", "app"]);
const NAME_RE = /^[a-z0-9-]{2,32}$/;
const TEXT_MAX = 8 * 1024;
const URL_MAX = 2 * 1024;
const RATE_LIMIT = 10; // 每 IP 每分钟

function randomName(len = 6) {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < len; i++) s += chars[buf[i] % chars.length];
  return s;
}

function isUrl(s) {
  return /^https?:\/\//i.test(s.trim());
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function rateLimit(env, ip) {
  const key = "rl:" + ip + ":" + Math.floor(Date.now() / 60000);
  const v = await env.NOTES.get(key);
  const n = v ? parseInt(v, 10) + 1 : 1;
  await env.NOTES.put(key, String(n), { expirationTtl: 120 });
  return n <= RATE_LIMIT;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html;charset=utf-8" } });
}

function editorPage() {
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>n.chen.rs — 临时笔记 / 短链</title>\n' +
'<style>\n' +
':root{color-scheme:light dark}\n' +
'*{box-sizing:border-box;margin:0}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;background:#fafafa}\n' +
'@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#eee}.card{background:#161616;border-color:#333}input,textarea{background:#222;color:#eee;border-color:#444}.hint{color:#999}}\n' +
'.card{max-width:640px;width:100%;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:2rem;box-shadow:0 4px 20px rgba(0,0,0,.04)}\n' +
'h1{font-size:1.25rem;margin-bottom:.3rem}\n' +
'.hint{font-size:.85rem;color:#666;margin-bottom:1.5rem;line-height:1.7}\n' +
'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(128,128,128,.12);padding:.05rem .3rem;border-radius:3px;font-size:.82rem}\n' +
'label{display:block;font-size:.85rem;color:#666;margin:1rem 0 .4rem}\n' +
'input,textarea{width:100%;padding:.6rem .8rem;border:1px solid #ddd;border-radius:8px;font-family:inherit;font-size:.95rem}\n' +
'textarea{min-height:220px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;line-height:1.5}\n' +
'.row{display:flex;gap:.5rem;align-items:center}.row input{flex:1}.row .suffix{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#888;font-size:.9rem}\n' +
'button{margin-top:1.25rem;padding:.75rem 1.5rem;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer;font-size:.95rem;font-weight:500}\n' +
'button:hover{background:#333}\n' +
'@media(prefers-color-scheme:dark){button{background:#fff;color:#000}button:hover{background:#ddd}}\n' +
'</style></head><body>\n' +
'<div class="card">\n' +
'<h1>临时笔记 / 短链</h1>\n' +
'<div class="hint">贴一段文字 → 笔记页<br>贴一个 <code>http(s)://</code> 链接 → 302 短链<br>同名不覆盖。也可直接拼：<code>/?c=内容&amp;n=名字</code></div>\n' +
'<form onsubmit="return go(event)">\n' +
'<label>自定义名字（可选，留空随机 6 位）</label>\n' +
'<div class="row"><input id="n" autocomplete="off" pattern="[a-z0-9-]{2,32}" placeholder="例如 abc"><span class="suffix">.n.chen.rs</span></div>\n' +
'<label>内容</label>\n' +
'<textarea id="c" required autofocus placeholder="文字 / https://..."></textarea>\n' +
'<button type="submit">生成 →</button>\n' +
'</form></div>\n' +
'<script>function go(e){e.preventDefault();var n=document.getElementById("n").value.trim();var c=document.getElementById("c").value;var p=new URLSearchParams();if(n)p.set("n",n);p.set("c",c);location.href="/?"+p.toString();return false}</script>\n' +
'</body></html>';
  return html(body);
}

function resultPage(name, content, existed) {
  const short = "https://" + name + "." + BASE_HOST;
  const link = isUrl(content);
  const typeBg = link ? "#e0f2fe" : "#fef3c7";
  const typeFg = link ? "#0369a1" : "#92400e";
  const typeLabel = link ? "302 跳转" : "笔记";
  const targetLine = link
    ? ('跳转到：<a href="' + esc(content.trim()) + '">' + esc(content.trim().slice(0, 120)) + '</a>')
    : ('内容长度：' + content.length + ' 字符');
  const qrSrc = "https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=" + encodeURIComponent(short);

  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + (existed ? '已存在' : '已创建') + ' · ' + esc(name) + '</title>\n' +
'<style>\n' +
':root{color-scheme:light dark}*{box-sizing:border-box;margin:0}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem;background:#fafafa}\n' +
'@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#eee}.card{background:#161616;border-color:#333}input{background:#222;color:#eee;border-color:#444}.meta{color:#999}.meta a{color:#eee}}\n' +
'.card{max-width:560px;width:100%;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:2rem;box-shadow:0 4px 20px rgba(0,0,0,.04)}\n' +
'h1{font-size:.8rem;color:#888;font-weight:500;margin-bottom:1rem;text-transform:uppercase;letter-spacing:.08em;display:flex;gap:.5rem;align-items:center}\n' +
'.type{padding:.15rem .5rem;border-radius:4px;background:' + typeBg + ';color:' + typeFg + ';font-size:.7rem;font-weight:600}\n' +
'.url{display:flex;gap:.5rem;margin-bottom:1rem}\n' +
'.url input{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.05rem;padding:.75rem 1rem;border:1px solid #ddd;border-radius:8px}\n' +
'button{padding:.75rem 1.25rem;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;font-size:.95rem;color:inherit}button:hover{background:rgba(128,128,128,.12)}\n' +
'.meta{font-size:.85rem;color:#666;margin-top:1rem;line-height:1.8}.meta a{color:inherit}\n' +
'.qr{margin-top:1.5rem;display:flex;justify-content:center}.qr img{border-radius:8px;background:#fff;padding:8px}\n' +
'.foot{margin-top:1.25rem;text-align:center;font-size:.8rem}.foot a{color:#888;text-decoration:none}\n' +
'</style></head><body>\n' +
'<div class="card">\n' +
'<h1>' + (existed ? '已存在' : '已创建') + ' <span class="type">' + typeLabel + '</span></h1>\n' +
'<div class="url"><input id="u" value="' + esc(short) + '" readonly onclick="this.select()"><button onclick="navigator.clipboard.writeText(document.getElementById(\'u\').value).then(()=>{this.textContent=\'已复制\';setTimeout(()=>this.textContent=\'复制\',1500)})">复制</button></div>\n' +
'<div class="meta">访问：<a href="' + esc(short) + '">' + esc(short) + '</a><br>原文：<a href="' + esc(short) + '/raw">' + esc(short) + '/raw</a><br>' + targetLine + '</div>\n' +
'<div class="qr"><img alt="QR" src="' + esc(qrSrc) + '" width="160" height="160" loading="lazy"></div>\n' +
'<div class="foot"><a href="/">+ 再创建一个</a></div>\n' +
'</div></body></html>';
  return html(body);
}

function notePage(sub, content) {
  const body = '<!DOCTYPE html>\n' +
'<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(sub) + ' · n.chen.rs</title>\n' +
'<style>:root{color-scheme:light dark}*{box-sizing:border-box;margin:0}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;padding:2rem;max-width:760px;margin:0 auto;line-height:1.6;background:#fafafa;color:#111}\n' +
'@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#eee}pre{background:#161616;border-color:#333}header{border-color:#333}}\n' +
'header{display:flex;justify-content:space-between;align-items:center;padding-bottom:.75rem;margin-bottom:1.5rem;border-bottom:1px solid #e5e5e5;font-size:.85rem;color:#888}\n' +
'header a{color:inherit;text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}\n' +
'pre{white-space:pre-wrap;word-wrap:break-word;background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:1.25rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.95rem;line-height:1.55}\n' +
'button{padding:.35rem .75rem;border:1px solid #ddd;border-radius:6px;background:transparent;cursor:pointer;font-size:.8rem;color:inherit}button:hover{background:rgba(128,128,128,.12)}\n' +
'</style></head><body>\n' +
'<header><a href="/raw">' + esc(sub) + '.' + BASE_HOST + '</a>\n' +
'<button onclick="navigator.clipboard.writeText(document.getElementById(\'c\').innerText).then(()=>{this.textContent=\'已复制\';setTimeout(()=>this.textContent=\'复制\',1200)})">复制全文</button></header>\n' +
'<pre id="c">' + esc(content) + '</pre>\n' +
'</body></html>';
  return html(body);
}

function notFoundPage(sub) {
  const body = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>404</title>' +
'<style>body{font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;color:#666;background:#fafafa;text-align:center}@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#aaa}}a{color:inherit}</style>' +
'</head><body><div><h1 style="margin:0;font-size:3rem">404</h1><p><code>' + esc(sub) + '</code> 不存在，<a href="https://' + BASE_HOST + '/">去创建 →</a></p></div></body></html>';
  return html(body, 404);
}

async function handleCreate(req, env, url) {
  const ip = req.headers.get("cf-connecting-ip") || "0";
  if (!(await rateLimit(env, ip))) return new Response("Rate limit exceeded (10/min)", { status: 429 });

  let name = (url.searchParams.get("n") || "").toLowerCase().trim();
  const content = url.searchParams.get("c") || "";
  if (!content) return editorPage();

  const urlMode = isUrl(content);
  if (urlMode && content.length > URL_MAX) return new Response("URL too long", { status: 413 });
  if (!urlMode && content.length > TEXT_MAX) return new Response("Text too long", { status: 413 });

  if (name) {
    if (!NAME_RE.test(name)) return new Response("Invalid name (need [a-z0-9-]{2,32})", { status: 400 });
    if (RESERVED.has(name)) return new Response("Reserved name", { status: 400 });
  } else {
    for (let i = 0; i < 6; i++) {
      const cand = randomName(6);
      if (RESERVED.has(cand)) continue;
      if (!(await env.NOTES.get("n:" + cand))) { name = cand; break; }
    }
    if (!name) return new Response("Could not allocate name", { status: 500 });
  }

  const key = "n:" + name;
  const existing = await env.NOTES.get(key);
  if (existing !== null) return resultPage(name, existing, true);

  await env.NOTES.put(key, content);
  return resultPage(name, content, false);
}

async function handleSubdomain(env, host, pathname) {
  const sub = host.slice(0, -(BASE_HOST.length + 1));
  if (!NAME_RE.test(sub)) return notFoundPage(sub);
  const content = await env.NOTES.get("n:" + sub);
  if (content === null) return notFoundPage(sub);
  if (pathname === "/raw") {
    return new Response(content, { headers: { "content-type": "text/plain;charset=utf-8" } });
  }
  if (isUrl(content)) return Response.redirect(content.trim(), 302);
  return notePage(sub, content);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    if (host === BASE_HOST) {
      if (url.pathname === "/" || url.pathname === "") {
        if (url.searchParams.has("c") || url.searchParams.has("n")) return handleCreate(req, env, url);
        return editorPage();
      }
      return new Response("Not found", { status: 404 });
    }
    if (host.endsWith("." + BASE_HOST)) return handleSubdomain(env, host, url.pathname);
    return new Response("Not found", { status: 404 });
  },
};
