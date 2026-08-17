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
| `POST <sub>.0g.hk/` | 编辑 / 改 TTL / 续期（token 走 `X-Edit-Token` 头或 body） |

**AI 友好**：`curl 0g.hk` 拿到的是纯文本手册，不是 HTML。所以告诉 AI「去 `0g.hk` 看说明书然后帮我建一个 `foo`」它能自己走通。

## 约定

- **Opt-in JSON**：请求加 `Accept: application/json` 或 query 参数 `?format=json` → 响应即 JSON。否则走 HTML。
- **OPTIONS**：任何路径对 `OPTIONS` 返回 CORS preflight。
- **Rate limit**：Worker 内置创建/编辑 10 req/min/IP。超限返 `429`，JSON details 含 `limit` 与 `windowSeconds: 60`；`/exists` / 举报等高频路径可另由 Cloudflare 边缘限流。
- **Metadata headers**（创建、JSON 读取、302、/raw 都会带；普通 HTML 笔记页不保证带）：
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
| `content` / `c` | body 优先，query 回退 | 笔记正文（≤24KB，可在 /admin/config 调整）或 URL（≤2KB，可省略 `https://`） |
| `name` / `n`    | 可选           | 首尾必须是小写字母/数字，中间可含 `-`；空格/下划线自动转 `-`。不给则随机 6 字符；自定义名建议保持 DNS label 长度（≤63 字符） |
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

JSON 响应包含：`apiVersion, name, kind, shortUrl, rawUrl, content, target, ttl, createdAt, expiresAt, contentLength`（**不含 editToken**）。

## 编辑 / 续期

`POST <sub>.0g.hk/`，`content` / `ttl` / `renew` 三者皆可选，给什么改什么。每次编辑都会把 `expiresAt` 窗口**重置**为 `now + ttl`。

编辑 token 有三种传法，**验证逻辑与返回值完全一致**：

| 传法 | 形式 | 状态 |
|---|---|---|
| 请求头 | `X-Edit-Token: <token>` | 推荐 |
| body 字段 | `{"token": "<token>"}` | 推荐 |
| query 参数 | `?edit=<token>` | **已废弃**，仍受支持 |

推荐前两种的原因：query 参数会进入 Worker 日志、Cloudflare 请求日志、`Referer` 头和浏览器历史。`?edit=` 保留是为了向后兼容，日志中它的值会被脱敏成 `edit=[redacted]`。

```bash
# 改内容（TTL 沿用旧值，窗口重置）
curl -sS -X POST "https://foo.0g.hk/" \
  -H "X-Edit-Token: $TOKEN" \
  -H 'Content-Type: text/plain' \
  --data-binary '新内容'

# 改 TTL（内容沿用，窗口重置）
curl -sS -X POST "https://foo.0g.hk/?ttl=1d" -H "X-Edit-Token: $TOKEN"

# 纯续期（内容、TTL 都沿用，仅把窗口重置）
curl -sS -X POST "https://foo.0g.hk/?renew=1" -H "X-Edit-Token: $TOKEN"

# 全 JSON（token 在 body 里）
curl -sS -X POST "https://foo.0g.hk/" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"token":"'"$TOKEN"'","content":"新内容","ttl":"7d"}'

# 已废弃的 query 形式，仍然可用
curl -sS -X POST "https://foo.0g.hk/?edit=$TOKEN&ttl=1d"
```

> 注意：`X-Edit-Token` 只在 `POST` / `PUT` 上生效。带该头的 `GET` 是**普通读取**，不会修改任何东西。只有已废弃的 `?edit=` 形式会在 `GET` 上执行写入。

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
{"ok": false, "error": {"code": "name_taken", "message": "...", "details": {"name": "foo"}}}
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
| 400  | `bad_scheme`       | 非 http/https 或危险 URL scheme    |
| 400  | `shortener_blocked` | 禁止把其他短链服务作为跳转目标     |
| 400  | `unsafe_target`    | Safe Browsing 判定目标 URL 不安全   |
| 400  | `content_blocked`  | 内容安全模型判定为滥用内容         |
| 400  | `bad_body`         | POST body 无法解析                 |
| 403  | `not_editable`     | 笔记不存在或元数据缺失             |
| 403  | `invalid_token`    | 编辑 token 错误                    |
| 404  | `not_found`        | 子域笔记不存在                     |
| 409  | `name_taken`       | 名字已被占用                       |
| 410  | `disabled`         | 内容因举报或管理操作被禁用         |
| 413  | `url_too_long`     | URL 超 2KB                         |
| 413  | `text_too_long`    | 文本超限 (默认 24KB，可在 /admin/config 调整)                         |
| 429  | `rate_limited`     | 超频（10/min/IP）                  |
| 500  | `corrupt_meta`     | 元数据损坏（应上报）               |
| 500  | `alloc_failed`     | 随机名 6 次仍冲突（应上报）        |

HTML 模式下错误会返回带样式的错误页；JSON 模式仍返回结构化错误对象。

## 举报与自动隔离

`POST <sub>.0g.hk/abuse/report`。

- **一个举报人 = 一个地址段**。计数按 IPv6 `/64` 或 IPv4 `/24` 归并，同一段内换地址不会增加计数（同段重复举报返回 `deduped: true`）。
- **人机校验**：部署配置了 `TURNSTILE_SECRET` 时，举报需携带 Turnstile token（`X-Turnstile-Token` 头，或 body 的 `turnstile` / `cf-turnstile-response` 字段）。校验失败返回 `403 challenge_failed`，且**不会**改动任何计数。未配置该 secret 时校验为空操作，行为与以前一致。
- **自动动作是有界且可撤销的隔离**，不是永久禁用。累计 **10 个不同地址段**举报后写入隔离标记，其存活时间取笔记自身剩余寿命并夹在 `[1h, 7d]` 内 —— 标记不会比它保护的内容活得更久。
- 被隔离的笔记返回 `410 disabled`（与管理员禁用同一状态码与错误码）。自动隔离额外在 JSON 里带 `details.auto: true` 和 `details.until`，页面上也会显示自动解除时间与申诉邮箱。
- 管理员可通过 `POST /admin/enable?name=<n>` 立即解除（同时清除标记与计数）。没有自助解除接口：对真正的恶意笔记，持有编辑 token 的正是滥用者。

## 浏览器兼容

所有旧路径未变：

- `GET /?c=...&n=...` → HTML 结果页（token 在卡片里）
- `GET <sub>.0g.hk/?edit=tk&c=new` → HTML 结果页（已废弃但仍支持；token 在日志中被脱敏）
- `GET <sub>.0g.hk` → 302 / 跳转中间页 / 笔记页
- `GET <sub>.0g.hk/edit` → 编辑器 UI

浏览器不会意外走 JSON：只有显式 `?format=json` 或明确 `Accept: application/json` 才切换。
