# 0g.hk API

工程友好的 HTTP 接口。所有路径 100% 向后兼容浏览器 HTML 路径；以下是 CLI / 脚本推荐用法。

## 总览

| 路径 | 行为 |
|---|---|
| `POST 0g.hk/` | 创建笔记 / 短链 |
| `GET  0g.hk/` (浏览器) | HTML 首页 + 编辑器 |
| `GET  0g.hk/` (curl / AI / 非浏览器 UA) | 纯文本 usage 手册（content negotiation） |
| `GET  0g.hk/?n=foo` | HTML 编辑器，预填子域名 |
| `GET  0g.hk/?c=...[&n=][&ttl=]` | 浏览器快捷创建 |
| `GET  0g.hk/llms.txt` | 稳定的纯文本 usage 手册（同上，但显式） |
| `GET  0g.hk/exists?n=foo` | 名字可用性校验 |
| `GET  <sub>.0g.hk/` | 302 / 跳转中间页 / 笔记页 |
| `GET  <sub>.0g.hk/raw` | 原文 + metadata header |
| `GET  <sub>.0g.hk/edit` | 编辑器 UI |
| `POST <sub>.0g.hk/?edit=tk` | 编辑 / 改 TTL / 续期 |

**AI 友好**：`curl 0g.hk` 拿到的是纯文本手册，不是 HTML。所以告诉 AI「去 `0g.hk` 看说明书然后帮我建一个 `foo`」它能自己走通。

## 约定

- **Opt-in JSON**：请求加 `Accept: application/json` 或 query 参数 `?format=json` → 响应即 JSON。否则走 HTML。
- **OPTIONS**：任何路径对 `OPTIONS` 返回 CORS preflight。
- **Rate limit**：10 req/min/IP（创建 + 编辑共享）。超限返 `429` + `Retry-After` 语义（`windowSeconds: 60`）。
- **Metadata headers**（创建、读取、302、/raw 都会带）：
  - `X-Name`
  - `X-Short-Url` · `X-Raw-Url`
  - `X-Kind`：`url` 或 `text`
  - `X-Ttl` · `X-Expires-At`（ISO8601 或 `never`）· `X-Created-At`
  - `X-Target`：当 kind=url 时有
  - `X-Edit-Token` · `X-Edit-Url`：仅创建时返回，**只此一次**
  - `Access-Control-Expose-Headers` 已自动设置，浏览器 JS 可读取

## 创建

### 最小示例

```bash
# 从 stdin / text/plain body，名字自动分配
curl -sS -X POST https://0g.hk/ \
  -H 'Content-Type: text/plain' \
  -H 'Accept: application/json' \
  --data-binary 'hello world' | jq .
```

响应 `201 Created`：

```json
{
  "ok": true,
  "apiVersion": 1,
  "name": "k3m2x9",
  "kind": "text",
  "shortUrl": "https://k3m2x9.0g.hk",
  "rawUrl": "https://k3m2x9.0g.hk/raw",
  "editToken": "AbCd...",
  "editUrl": "https://k3m2x9.0g.hk/edit#t=AbCd...",
  "ttl": "7d",
  "createdAt": "2026-04-20T00:00:00.000Z",
  "expiresAt": "2026-04-27T00:00:00.000Z",
  "target": null,
  "contentLength": 11
}
```

### 只要短链（一行输出）

```bash
curl -sS -X POST 'https://0g.hk/?n=foo&ttl=7d' \
  -H 'Content-Type: text/plain' \
  --data-binary 'https://github.com/catoncat/0g-hk' \
  -D - -o /dev/null | awk 'tolower($1)=="x-short-url:"{print $2}'
```

### JSON body

```bash
curl -sS -X POST https://0g.hk/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"content":"https://github.com/catoncat/0g-hk","name":"repo","ttl":"7d"}'
```

### Form body

```bash
curl -sS -X POST https://0g.hk/ \
  -H 'Accept: application/json' \
  --data-urlencode 'c=hello world' \
  --data-urlencode 'n=hi' \
  --data-urlencode 'ttl=7d'
```

### 参数

| 参数      | body/query     | 说明                                                                 |
| --------- | -------------- | -------------------------------------------------------------------- |
| `content` / `c` | body 优先，query 回退 | 笔记正文（≤8KB）或以 `http(s)://` 开头的 URL（≤2KB） |
| `name` / `n`    | 可选           | 小写字母/数字/-（空格/下划线自动转 -）。不给则随机 6 字符              |
| `ttl`           | 可选           | `1h` / `1d` / `7d`（默认 `7d`，由产品策略限定最长 7 天，到期前可用 `renew` 续期）               |

text/plain body 时整个 body 即 `content`，无名/TTL 参数（用 query string 补）。

## 读取

```bash
# 原文
curl -sS https://foo.0g.hk/raw

# 元数据 + 原文（JSON）
curl -sS -H 'Accept: application/json' https://foo.0g.hk/
# 或
curl -sS 'https://foo.0g.hk/?format=json'

# 只看 metadata header
curl -sSI https://foo.0g.hk/raw
```

JSON 响应包含：`name, kind, shortUrl, rawUrl, content, target, ttl, createdAt, expiresAt, contentLength`（**不含 editToken**）。

## 编辑 / 续期

`POST <sub>.0g.hk/?edit=<token>`，`content` / `ttl` / `renew` 三者皆可选，给什么改什么。每次编辑都会把 `expiresAt` 窗口**重置**为 `now + ttl`。

```bash
# 改内容（TTL 沿用旧值，窗口重置）
curl -sS -X POST "https://foo.0g.hk/?edit=$TOKEN" \
  -H 'Content-Type: text/plain' \
  --data-binary '新内容'

# 改 TTL（内容沿用，窗口重置）
curl -sS -X POST "https://foo.0g.hk/?edit=$TOKEN&ttl=1d"

# 纯续期（内容、TTL 都沿用，仅把窗口重置）
curl -sS -X POST "https://foo.0g.hk/?edit=$TOKEN&renew=1"

# 全 JSON
curl -sS -X POST "https://foo.0g.hk/" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"token":"'"$TOKEN"'","content":"新内容","ttl":"7d"}'
```

TTL 仅可在 `1h` / `1d` / `7d` 之间切换。超过 7 天到期后数据即删除，无法恢复。

## 检查名字是否可用

```bash
curl -sS 'https://0g.hk/exists?n=foo'
# => {"valid":true,"exists":false}
```

不可用时会返回细分原因：

```json
{"valid":false,"reason":"reserved"}
{"valid":false,"reason":"brand","term":"apple"}
{"valid":false,"reason":"invalid"}
```

## 错误

所有错误响应（JSON 模式下）：

```json
{"ok": false, "error": {"code": "name_taken", "message": "...", "name": "foo"}}
```

| HTTP | `code`             | 含义                               |
| ---- | ------------------ | ---------------------------------- |
| 400  | `missing_content`  | 无正文                             |
| 400  | `missing_token`    | 编辑缺 token                       |
| 400  | `invalid_name`     | 名字格式不合法                     |
| 400  | `reserved_name`    | 预留名                             |
| 400  | `brand_blocked`    | 名字包含品牌/钓鱼高风险词         |
| 400  | `invalid_ttl`      | TTL 值无效（返回 `allowed` 数组）  |
| 400  | `malformed_url`    | URL 解析失败                       |
| 400  | `bad_body`         | POST body 无法解析                 |
| 403  | `not_editable`     | 笔记不存在或元数据缺失             |
| 403  | `invalid_token`    | 编辑 token 错误                    |
| 404  | `not_found`        | 子域笔记不存在                     |
| 409  | `name_taken`       | 名字已被占用                       |
| 413  | `url_too_long`     | URL 超 2KB                         |
| 413  | `text_too_long`    | 文本超 8KB                         |
| 429  | `rate_limited`     | 超频（10/min/IP）                  |
| 500  | `corrupt_meta`     | 元数据损坏（应上报）               |
| 500  | `alloc_failed`     | 随机名 6 次仍冲突（应上报）        |

HTML 模式下错误会返回带样式的错误页；JSON 模式仍返回结构化错误对象。

## 浏览器兼容

所有旧路径未变：

- `GET /?c=...&n=...` → HTML 结果页（token 在卡片里）
- `GET <sub>.0g.hk/?edit=tk&c=new` → HTML 结果页
- `GET <sub>.0g.hk` → 302 / 跳转中间页 / 笔记页
- `GET <sub>.0g.hk/edit` → 编辑器 UI

浏览器不会意外走 JSON：只有显式 `?format=json` 或明确 `Accept: application/json` 才切换。
