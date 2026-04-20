# 0g.hk

> 禁得起 `curl` 的短链 / 临时笔记 —— 域名即文案。

```
<子域名>.0g.hk   →   一条链接、一段文字、一份 AI prompt
```

无账号、无数据库、无追踪脚本。Cloudflare Worker + KV，单文件 ~970 行。

## 三十秒上手

```bash
# 文本进去、短链出来
curl -sS --data-binary 'hello world' 0g.hk/

# 机器可读
curl -sS -H 'Accept: application/json' --data-binary 'hello world' 0g.hk/ | jq .

# 自定名 + URL 短链 + 7 天
curl -sS -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"content":"https://github.com/catoncat/0g-hk","name":"repo","ttl":"7d"}' \
  0g.hk/
```

浏览器直接打开 <https://0g.hk> 也有编辑器。AI / 脚本用 `curl 0g.hk` 拿到的是**纯文本手册**而不是 HTML（content negotiation）。

完整 API：[`docs/API.md`](docs/API.md) · 纯文本快速参考：<https://0g.hk/llms.txt>

## 产品约束

| 项 | 值 |
|---|---|
| 内容类型 | 文本（≤ 8KB）或 URL（≤ 2KB） |
| 子域名 | `[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?`，2–32 字符，首尾非 `-` |
| TTL | `1h` / `1d` / `7d`，默认 `7d`，**最长 7 天** |
| 续期 | `POST <sub>.0g.hk/?edit=<token>&renew=1`，重置到期窗口 |
| 编辑 token | 创建时返回一次，KV 只存 hash。丢了就改不了 |
| Rate limit | 10 req/min/IP，纯 KV 计数 |
| 保留名 | `www api new admin edit raw n app abuse report exists` |

## 路由（概览）

| 请求 | 行为 |
|---|---|
| `POST 0g.hk/` | 创建（text/plain · JSON · form 三种 body 皆可） |
| `GET  0g.hk/?c=...&n=...` | 浏览器快捷创建，返回 HTML 结果页 |
| `GET  0g.hk/?n=foo` | HTML 编辑器预填子域名 |
| `GET  0g.hk/` · 浏览器 | HTML 首页（带案例、创建入口） |
| `GET  0g.hk/` · curl/AI | 纯文本 usage 手册 |
| `GET  0g.hk/llms.txt` | 永远纯文本 usage 手册 |
| `GET  0g.hk/exists?n=foo` | `{valid,exists}` 校验 |
| `GET  <sub>.0g.hk` | 302 跳转 · 跳转中间页 · 笔记页（视内容/白名单） |
| `GET  <sub>.0g.hk/raw` | 原文 + metadata headers |
| `GET  <sub>.0g.hk/edit` | 编辑器 UI（token 放 URL hash） |
| `POST <sub>.0g.hk/?edit=tk[&content=&ttl=&renew=1]` | 编辑 / 改 TTL / 续期 |

## 设计小记

- **子域即资源**：`repo.0g.hk` 比 `0g.hk/abc123` 好记十倍；推广时「链接本身就是文案」（`check-this-out.0g.hk`、`name-your-own-links.0g.hk`…）。
- **Content negotiation at `/`**：浏览器拿 HTML、`curl` / AI 拿 plain-text。告诉 AI「去 `0g.hk` 看说明书然后帮我建个 `foo`」就能跑通。
- **KV key 布局**：`n:<name>` 存内容，`m:<name>` 存元数据（token hash + TTL key + createdAt）。TTL 由 KV 原生 `expirationTtl` 管理，到期自动消失。
- **Edit token**：创建时一次性返回 + 仅哈希入库。刻意不提供「找回」，鼓励把短链本身当做可丢弃资源。
- **跳转白名单**：主流站（GitHub / X / YouTube / Notion / …）直接 302，其余先过跳转中间页以降低 phishing 滥用成本。
- **Rate limit**：10/min/IP，key 形如 `rl:<ip>:<minute>`，完全 KV-only，无外部依赖。
- **首页缓存**：裸首页 `cache-control: public, max-age=300, stale-while-revalidate=86400`；带预填 / 错误态的则 `no-store`。

## 仓库结构

```
src/index.js        Worker 入口 —— 所有逻辑 + HTML UI 全在一起
docs/API.md         HTTP API 参考（工程向）
wrangler.toml       Cloudflare Worker 配置
```

## 本地开发 / 部署

```bash
npm i -g wrangler        # 或 bun i -g wrangler
wrangler dev             # 本地
wrangler deploy          # 推到生产（account_id 已写在 wrangler.toml）
```

域名绑定：`0g.hk` 作为 Custom Domain，`*.0g.hk/*` 作为通配路由；KV namespace 绑在 `NOTES`。

## 许可

MIT。家用项目，开放但不承诺稳定。
