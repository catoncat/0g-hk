# 0g.hk

> 一个禁得起 `curl` 的短链 · 临时笔记。

`xxx.0g.hk` → 一条链接、一段文字。无账号、无数据库。
Cloudflare Worker + KV，单文件约 800 行。

## 用

```bash
# 文本直接用 body
curl -sS --data-binary 'hello' 0g.hk/
# => HTML 结果页

# 想要机器可读
curl -sS -H 'Accept: application/json' --data-binary 'hello' 0g.hk/ | jq .

# 自定名 + TTL
curl -sS -H 'Accept: application/json' \
  -d '{"content":"https://github.com/catoncat/0g-hk","name":"repo","ttl":"forever"}' \
  -H 'Content-Type: application/json' \
  0g.hk/
```

浏览器直接打开 <https://0g.hk> 也有编辑器。

完整 API：[`docs/API.md`](docs/API.md)。

## 仓库结构

```
src/index.js        # Worker 入口（所有逻辑 + UI 一起）
docs/API.md         # HTTP API 参考
wrangler.toml       # Cloudflare 配置（家用，account_id 不应提交的但个人项目简化）
```

## 开发

```bash
npm i -g wrangler   # 或 bun i -g wrangler
wrangler dev        # 本地﹣

wrangler deploy     # 推到生产
```

主域 `0g.hk` + 通配 `*.0g.hk` 由 Cloudflare DNS + Workers route 绑定。
KV namespace 绑在 `NOTES`。

## 设计

- **子域即资源**：`talk.0g.hk`、`repo.0g.hk` 比 `0g.hk/abc123` 好记 10 倍。
- **KV key pattern**：`n:<name>` 内容，`m:<name>` 元数据（token hash + TTL + 创建时间）。
- **Edit token**：创建时发一次，只传到用户手里，KV 只存 hash。丢了就改不了——这正是想要的性质。
- **跳转白名单**：主流站直接 302，其余站点先过跳转中间页，减少 phishing 滥用。
- **Rate limit**：10/分钟/IP，纯 KV 计数，不接外部服务。

## 许可

MIT。家用项目，虽偏开放，但不承诺稳定。
