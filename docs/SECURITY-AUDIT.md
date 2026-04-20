# 0g.hk 安全审计与合规加固报告

日期：2026-04-20
版本：Worker `n-chen-rs` v2026.04.20（部署版本 `bf72e6ad-417b-4836-980a-c5cd54085a10`）
作者：安全审阅

> 本文同步保存为私有 Notion 文档（未发布），供内部参考。

---

## TL;DR

`0g.hk` 是基于 Cloudflare Worker + KV 的极简短链 / 粘贴服务，公开、免注册、可自定义 `*.0g.hk` 子域。在没有任何门禁的情况下，它天然具备成为**钓鱼温床**的所有条件：

- 自选子域 → 攻击者可注册 `apple-login.0g.hk`、`icloud-verify.0g.hk`、`metamask-wallet.0g.hk` 等品牌仿冒名；
- 任意 URL 目标 → 可作为**开放重定向**串联到真正的钓鱼站；
- 任意文本 → 可托管 payload、`javascript:` 协议、恶意脚本片段；
- `0g.hk` 本身是真实可信的 CF 域 → 能过大多数邮件/IM 的链接黑名单；
- TLS + 简短 + 无登录 → 攻击成本极低。

本次加固后，**自选名走一条完整的「品牌防抢 → 协议 → 短链黑名单 → Google Safe Browsing → Cloudflare Workers AI 审核」门禁链**，并引入社区一键举报 + 3 次熔断自动禁用机制。随机名（6 字符 base36）因不可被预先抢注，仅保留 AI 审核即足够。

---

## 1. 原系统风险面（加固前）

| 层级 | 问题 | 危险度 |
|---|---|---|
| 名字 | 仅过滤 11 个保留词，允许 `apple-login` / `stripe-pay` / `binance-verify` 等 | 🔴 高 |
| URL 目标 | 仅检查格式；允许 `javascript:`/`data:`/`file:`？（默认 `isUrl` 只看 `http(s)`，但绕过点是 fallback 文本模式后走 302） | 🟠 中 |
| URL 链式 | 不阻止 `0g.hk` → `bit.ly` → 真·钓鱼域 | 🟠 中 |
| 内容审核 | 零审核 | 🔴 高 |
| 举报闭环 | 只有一个 `mailto:abuse@0g.hk`，没有自动化 | 🔴 高 |
| 速率限制 | 20/min/IP，够拖慢但挡不住 CAPTCHA farm / 住宅代理 | 🟡 中 |
| 机器人滥用 | 无人机验证 | 🟡 中 |

---

## 2. 本次加固清单（已上线）

### 2.1 名字层（`handleCreate`）

- **扩充保留词**：加入 `mail/dns/mx/ns/cdn/static/assets/help/docs/status` 等运维常用名。
- **品牌/钓鱼词黑名单 `BRAND_BLOCK`**：80+ 条，子串匹配（大小写无关），覆盖：
  - 全球科技/金融/电商巨头（Apple、Google、Microsoft、Amazon、PayPal、Stripe…）
  - 加密货币（Binance、Coinbase、MetaMask、Ledger、USDT…）
  - 中国互联网（Alipay、Taobao、WeChat、Douyin、Alibaba…）
  - 钓鱼常见动词（login、verify、signin、confirm、unlock、suspended、password…）
  - 快递诈骗（USPS、FedEx、DHL）
- **随机名不触发**：随机名使用 `0-9a-z` 固定 6 位生成，命中品牌词的概率近 0，且不可被攻击者「选中」，故跳过该层。

### 2.2 URL 层（创建 & 编辑都做一遍）

- **协议白名单**：仅 `http://` / `https://`；`javascript:`/`data:`/`vbscript:`/`file:`/`blob:`/`ftp:` 统一 `bad_scheme` 400。
- **短链链式禁用 `SHORTENER_HOSTS`**：包含 `bit.ly / t.co / tinyurl / goo.gl / is.gd / rebrand.ly / ...` 共 20+ 条，以及自身 `0g.hk`（禁止自我嵌套循环）。
- **Google Safe Browsing 集成**：`checkSafeBrowsing(env, url)` 通过 v4 Lookup API 查询 `MALWARE / SOCIAL_ENGINEERING / UNWANTED_SOFTWARE / POTENTIALLY_HARMFUL_APPLICATION`。**门槛设计**：
  - 未配置 `env.SAFE_BROWSING_KEY` 时 → 跳过（fail open），不影响现网。
  - 配置后任何命中 → `unsafe_target` 400。
  - 供应商故障（HTTP 非 2xx / JSON 异常）→ fail open，避免把 GCP 故障变成我们的故障。
  - 启用方式：`wrangler secret put SAFE_BROWSING_KEY`。

### 2.3 Cloudflare Workers AI 审核（新增，**默认启用**）

- 绑定：`wrangler.toml` 的 `[ai] binding = "AI"`。
- 模型：`@cf/meta/llama-3.1-8b-instruct-fast`（免费额度 10k neurons/天，对每秒个位数创建请求完全够用）。
- Prompt：JSON-only 严格输出 `{abuse, label, confidence, reason}`，7 类标签（phishing / malware / scam / csam / illegal / spam / other / none）。
- **阈值**：`abuse=true` 且 `confidence>=0.55` 才拦截，否则放行 → 降低误杀。
- **缓存**：结果写入 KV 24h（key = `aimod:<kind>:<sha256(content)_32>`），同一 URL / 文本不重复调用模型。
- **Fail open**：AI 超时、异常、不合法 JSON → 视为「未能分类」，不拦截正常用户，只在日志记 `reason=ai_error:...`。
- **覆盖场景**：创建 + 编辑都跑；编辑时如果仅续期（不改内容）则跳过。
- **实测结果**：
  - 输入 `"Urgent: your Apple ID is suspended, sign in now at http://evil.example/verify..."` → `content_blocked / phishing / confidence=高 / reason=suspicious link and password prompt`。
  - 输入 `"这是一段普通的技术笔记：今天测试了 cloudflare workers AI..."` → 通过。

### 2.4 社区举报 + 自动熔断

- 新增端点：**任何 `*.0g.hk/abuse/report`**（GET 或 POST，JSON 或 HTML 都可）。
- 去重：`(name, ip 的网段级哈希, 当日 UTC 日期)` → 同一网段同一天只计 1 次。
- 计数器：KV key `abuse:<name>`，保存 30 天。
- **自动禁用阈值**：3 次独立举报 → 写 `d:<name>`（保存 365 天，即便原笔记 TTL 到期、同名被再申请也依然禁用）→ 后续所有读/编/跳转返回 410「内容已禁用」。
- 插页与笔记页「举报此链接」按钮改为直接调用该端点，无需邮件。
- 申诉通道仍为 `abuse@0g.hk`，但已不是唯一路径。

### 2.5 编辑接口的二次审核

- 初版漏洞：若攻击者注册一个干净链接 → 通过审核 → 之后 `POST /` 把内容偷换成钓鱼。
- 修复：`handleEdit` 在 `contentIn` 非空时，把 **URL 层 + AI 层再跑一遍**；纯续期不跑。

---

## 3. 未做但建议考虑的二期项

| 项 | 说明 | 优先级 |
|---|---|---|
| Turnstile 人机验证 | 代码已预留 `verifyTurnstile(env, req, token)`，只要 `wrangler secret put TURNSTILE_SECRET` 并在 `editorPage` 嵌入 `cf-turnstile` widget + 前端提交 token 即可启用。建议仅对**自选名**要求，随机名不强制。 | P1 |
| 失败率自学习的分级限速 | 当前 20/min/IP 是硬阈值；可以加一层「最近 1 小时被拒绝次数」的动态窗口。 | P2 |
| 站内 CSP / `Referrer-Policy` 加固 | 笔记页 `/raw` 已是 `text/plain`，但渲染页仍有 inline script。改为 nonce-CSP 可防存储型 XSS（当前 `esc()` 已足够，此项为纵深防御）。 | P2 |
| 按钮式「一键举报并屏蔽跳转」 | 举报后立即显示禁用页，而非简单 toast。UX 更清晰。 | P3 |
| 管理员面板 | 列出高举报量条目、手动禁用/恢复 | P2 |
| 观测 | Workers Logs + Tail 采样、每日拒绝原因 Top-N 统计 | P1 |
| CSAM 哈希匹配 | 若未来允许图片上传则必须接 PhotoDNA/Microsoft Content Safety。当前只支持文本/URL，暂不紧迫。 | N/A |

---

## 4. 上线验证

```
$ curl -s 'https://0g.hk/?n=apple-login&c=https://example.com' -H 'accept: application/json'
{"ok":false,"error":{"code":"brand_blocked","message":"Name contains a restricted brand/phishing term (apple)","term":"apple"}}

$ curl -s 'https://0g.hk/' -H 'accept: application/json' \
    -d 'content=Urgent: your Apple ID is suspended, sign in at http://evil.example/verify...'
{"ok":false,"error":{"code":"content_blocked","label":"phishing","reason":"suspicious link and password prompt"}}

$ curl -s 'https://0g.hk/' -H 'accept: application/json' \
    -d 'content=这是一段普通的技术笔记：今天测试了 cloudflare workers AI 的 llama 3.1 8b 模型。'
{"ok":true,"name":"9t8vmf","kind":"text",...}
```

Worker bindings：

```
env.NOTES (KV)   : 5abeab410f7841eeb5b06942a3cfa42b
env.AI           : Cloudflare Workers AI
(可选) SAFE_BROWSING_KEY : 未配置 → Safe Browsing 跳过
(可选) TURNSTILE_SECRET  : 未配置 → Turnstile 跳过
```

---

## 5. 风险残留

1. **对抗性绕过**：攻击者可用 `app1e-login`、`rpple-verify` 等形变。品牌黑名单只能抬高成本，不能根除。AI 审核是兜底，但也可能被「混淆语义」的 prompt injection 攻击。→ 建议后续接入 Turnstile + 举报熔断作为主防线，AI 作为辅防线。
2. **Workers AI 免费额度**：Llama 3.1 8B-fast 每个请求大约 30–80 neurons，10k/day 足够单租户 100–300 QPH 的峰值；如暴涨应把阈值调严、或切 `@cf/tinyllama/tinyllama-1.1b-chat-v1.0` 快速档。
3. **Safe Browsing 延迟**：~150ms 额外延迟，仅对自选 URL 生效；随机 URL 用户无感。
4. **本地 `d:<name>` 永久禁用**：若将来需要恢复，只能手动 `wrangler kv key delete`。已记申诉邮箱。

---

## 6. 回滚

旧版本号：部署前 `Current Version ID`。若需回滚：

```
wrangler deployments list
wrangler rollback <old-version-id>
```

## 7. 二期加固（2026-04-20 14:45 上线，版本 `6bdc5024`）

- **安全响应头**：所有 HTML 响应统一注入 `Content-Security-Policy`（`default-src 'self'` + `challenges.cloudflare.com` 白名单）、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`（关闭 geo/mic/cam/pay）、`X-Robots-Tag: noindex, nofollow`。
- **自适应限速**：任一 IP 15 分钟内命中 ≥5 次安全拒绝，其每分钟限速自动从 10 降到 2；窗口到期自动恢复。KV 键 `rej-ip:<ip>` 15 分钟 TTL。
- **拒绝原因埋点**：5 个安全门禁（`brand_blocked` / `bad_scheme` / `shortener_blocked` / `unsafe_target` / `content_blocked`）按 UTC 日聚合写入 `rej:<YYYYMMDD>:<code>`（30 日 TTL）。
- **管理员面板**（由 `env.ADMIN_KEY` secret 开启；未配置统一返回 503）：
  - `GET /admin/stats`：最近 7 天各原因拒绝计数
  - `GET /admin/note?name=<sub>`：查看笔记元数据 / 是否禁用 / 举报计数
  - `POST /admin/disable?name=<sub>`：手动禁用（365d）
  - `POST /admin/enable?name=<sub>`：恢复并清空举报计数
  - 认证：`Authorization: Bearer <ADMIN_KEY>` 或 `?key=<ADMIN_KEY>`
- **Turnstile**：服务端 `verifyTurnstile` 已就绪；前端 widget 注入待 site key 到位后再开（需改编辑器为 POST + token 提交）。

### 配置命令
```bash
# 启用管理员 API
wrangler secret put ADMIN_KEY
# 启用 Google Safe Browsing（可选）
wrangler secret put SAFE_BROWSING_KEY
# 启用 Turnstile 服务端校验（可选）
wrangler secret put TURNSTILE_SECRET
```
