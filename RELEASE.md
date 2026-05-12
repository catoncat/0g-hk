# Release / Deploy Runbook

0g.hk 没有"staging 域名"——产品本身就在用 `*.0g.hk` 当用户笔记空间。
所以我们用 **Cloudflare Workers Gradual Deployments + Version Overrides**
在同一个 `0g.hk` 上做 pre-prod 灰度，只有带特定 cookie/header 的请求会打到新版本。

## TL;DR

```bash
# 1. 本地 dev 起来（mini-flare + Host 注入代理，见 scripts/dev-with-host-proxy.sh）
wrangler dev
# → browser-harness 截图给丁丁看，初步确认 UI

# 2. 上传新版本但不放流量（0%）
wrangler versions upload
# → 拿到 Version ID, e.g. 5ec47a78-1234-...

# 3. 丁丁在 CF Dashboard 点 Preview，浏览器逛真实 0g.hk（自己看到新版，其他人看到旧版）
#    Dashboard → Workers & Pages → n-chen-rs → Versions → 选新版本 → Preview

# 4. 丁丁拍板

# 5. 转正（100% 流量切到新版本）
wrangler versions deploy <version-id>@100%

# 6. 出问题秒回
wrangler rollback
```

## 详细流程

### Phase 1 — 本地视觉验证（必做）

UI/CSS/HTML 改动按 Dynamic Pioneer 指令的"前端设计改动验证流程"：

```bash
wrangler dev --port 8787
# 因为 BASE_HOST="0g.hk" 硬编码，browser 直接访问 127.0.0.1:8787 会落到 404
# 用 scripts/dev-with-host-proxy.sh 起一个 Python 代理，把 Host 改写成 0g.hk
scripts/dev-with-host-proxy.sh

# browser-harness 截图
browser-harness -c 'new_tab("http://127.0.0.1:8788/"); wait_for_load(); capture_screenshot("/tmp/preview.png", full=True)'
```

### Phase 2 — 上传新版本（0% 流量）

```bash
npm test               # 必须全绿
git status             # 必须 clean
wrangler versions upload
```

输出长这样：
```
Worker Version ID: 5ec47a78-1234-5678-90ab-cdef12345678
To deploy this version to production, use:
    wrangler versions deploy
```

**关键：此时新版本已经在 CF 边缘，但是 0% 流量。**
生产用户访问 `0g.hk` 看到的还是旧版。

### Phase 3 — 丁丁手动验收

Cloudflare Dashboard：
1. Workers & Pages → `n-chen-rs` → Versions 标签
2. 找到刚 upload 的版本（最上面那个）
3. 点 "Preview URL" 或 "Test in browser"
4. CF 给浏览器塞一个 cookie / header，**只有你**这个 session 会被路由到新版本
5. 在浏览器里逛真实的 `https://0g.hk/`、创建笔记、访问 `xxx.0g.hk`、试 markdown / 主题切换 / 管理后台
6. 没问题 → 给 agent 说 "ok 推全量"；有问题 → 描述问题，agent 改完再走 Phase 2

手动 curl 验收也行：
```bash
curl -H 'cf-workers-version-overrides: n-chen-rs="5ec47a78"' https://0g.hk/
```

### Phase 4 — 转正

```bash
wrangler versions deploy <version-id>@100%
# 一行 = 把 100% 流量切到新版本，旧版本变成历史
```

冒烟：
```bash
curl -sS -H 'Accept: text/html' https://0g.hk/ | grep -oE '<title>[^<]+</title>'
curl -sS https://0g.hk/exists?n=admin
```

### Phase 5 — 回滚（出事时）

```bash
wrangler rollback                    # 一键回上一个版本
# 或精确指定：
wrangler versions deploy <旧 id>@100%
```

## 关于数据

- pre-prod 和 prod **共用同一个 KV namespace** (`NOTES`, id `5abeab41...`)
- 丁丁验收时创建的笔记就是真笔记，会占用 `*.0g.hk` 命名空间
- 这是有意为之：彻底隔离会需要另一个域名，目前没必要
- 验收用的测试笔记建议名字带 `_test_` 前缀，或设短 TTL（如 `1d`）让它自毁

## 不要做的事

- ❌ 不要在没看截图的情况下直接 `wrangler deploy`
- ❌ 不要在 main 合 PR 后假设代码已上线——目前没有 CI/CD，**手动 `wrangler versions upload` + `versions deploy` 才会上线**
- ❌ 不要用 `wrangler deploy --env staging` 这条路了（已废弃，对子域路由测不出来）
- ❌ 不要用 cloudflared quick tunnel（CF 边缘会 403 hostname 路由型 Worker）

## 历史 / 设计取舍

- 试过 `[env.staging]` + `n-chen-rs-staging.copyright.workers.dev`：apex 能测但 `*.0g.hk` 子域路由完全测不到（workers.dev 不给 wildcard 子域），废弃
- 试过 `staging.0g.hk` 当 staging 入口：跟产品冲突——`*.0g.hk` 全是用户笔记空间
- 未来如果真需要数据隔离，再买个 `0g.cv` / `0gx.hk` 之类的域，把 `BASE_HOST` 改成从 env 读
