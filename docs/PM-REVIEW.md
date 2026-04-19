# 0g.hk 产品评审（PM 视角）

> 评审对象：`n-chen-rs`（部署在 `0g.hk` 的临时笔记 + 短链 Worker）
> 产出：白雪，2026-04-20
> Notion 版本：Notion Code teamspace / 《0g.hk 产品评审（PM 视角）》

## 一、这是什么产品

一句话：**"地址栏就是 UI" 的临时笔记 + 短链合体工具**。无账号、无存储概念、无客户端，只要能敲 URL 就能用。

核心交互极简：

```
https://0g.hk/?c=内容[&n=名字]      ← 写入
https://<名字>.0g.hk                ← 读取/跳转
https://<名字>.0g.hk/raw            ← 原文
```

## 二、真正的差异点

| 类别 | 代表 | 劣势 |
|---|---|---|
| 短链 | bit.ly, t.co | 要注册、UI 重、不能存文字 |
| 临时笔记 | pastebin, rentry | 要注册或至少点按钮；URL 不短 |
| 剪贴板 | 0x0.st, termbin | 要命令行 / 不可读 URL |

**0g.hk 的独特性**

1. **写入 = 一次 GET**，curl、浏览器地址栏、iOS 快捷指令、Alfred、bash alias 全都直接可用 → 天然可编程
2. **子域即资源**（`abc.0g.hk` 而非 `0g.hk/abc`）→ 短链一眼识别来源
3. **文字和 URL 合一**：输入是 URL 就跳转，不是就显示文本。用户不需要选模式
4. **零账号**

属于 hacker 审美 / 工具党会喜欢并口碑传播的产品。

## 三、当前的致命短板（按商业严重度）

### 🔴 1. "同名不覆盖" 反而是坑

用户场景：给演讲建 `talk.0g.hk`，一周后想更新——做不到。要么换名字（贴出去的 QR/链就废了），要么手动运维 KV（普通用户做不到）。

对策：

- 创建时给 edit token（`0g.hk/e/<token>`），持有者才能覆盖
- 或过期时间 7d / 30d / forever
- 或版本化追加

### 🔴 2. 没有过期，KV 会无限增长

人多了滥用者会写爆。至少应有：

- 默认 TTL（30 天？）+ 可选 `&ttl=forever` 或 `&ttl=1h`
- 或基于最后访问时间的 LRU
- 后台定时清理

### 🔴 3. 开放 302 重定向 = 钓鱼温床

`https://0g.hk/?c=https://evil.com&n=paypal-login` → `paypal-login.0g.hk` 看起来像合法子域。
一旦被大规模滥用做钓鱼：

- Google Safe Browsing 拉黑整个 `*.0g.hk`
- 浏览器红屏警告
- **域名声誉烧毁就救不回来**

最低防线：

- URL 模式走 302 时展示 "即将跳转到 X，点击继续" 中间页（可用参数跳过）
- 或 URL 模式只允许 allowlist（github.com、x.com、youtube.com 等），其他走中间页
- 接入 CF URL Scanner 或 Google Safe Browsing API
- 用户举报按钮

### 🟡 4. 名字先到先得，没有命名保护

有人批量占 `apple`、`stripe`、`openai`、`anthropic`……因为没过期就永久占坑。

### 🟡 5. 只读幂等 GET 竟有写副作用

`/?c=x&n=y` 是 GET 但会 PUT 到 KV：

- 贴到 Slack/iMessage，预览 bot 访问一次就创建了条目
- 搜索引擎爬到就写入
- 违反 HTTP 语义

折中：保留 GET 但要求 `&create=1` 才真正写，否则返回确认页。

### 🟡 6. UI 功能边界不清

缺：编辑页、统计页、自毁链接、Markdown 渲染。

## 四、规模化时会撞墙的地方

**KV 的局限**

- eventual consistency：A 区写，B 区 ~60s 才能读到
- 单 value ≤ 25MB；当前限 8KB 安全但没分片
- 无原子 CAS → 并发同名写理论存在竞态

**成本**

- KV 读 `$0.50`/百万、写 `$5`/百万
- 每次读子域走 2 次 KV（rate limit 读 + note 读），每次写要 2 次（check + put）+ rate limit put
- 规模起来后需优化

**滥用放大**：单 IP 10/min 是**创建**限制，**读取无限**。被 HN/Twitter 火了单域 QPS 可能几千，Free Plan 子请求限制、Worker CPU 时间都要压测。

## 五、路线图建议

### P0（保命，2 周内）

- [ ] 过期机制：默认 30 天，参数可覆盖
- [ ] URL 跳转中间页 + 常见域白名单直跳
- [ ] Safe Browsing 接入（或 CF URL Scanner 事后扫描）
- [ ] 举报入口（邮箱即可）

### P1（提留存，1 个月）

- [ ] Edit token：`?edit=<token>` 可覆盖同名
- [ ] 阅后即焚 `&burn=1`
- [ ] `/stats` 查看命中次数
- [ ] Markdown 可选渲染
- [ ] 中文子域名支持（IDN / Punycode），配套 Homograph 防护：只允许汉字 + 数字 + `-`，或单一 Unicode 脚本

### P2（追增长）

- [ ] CLI：`brew install 0g` → `0g "text"` / `0g https://...`
- [ ] Raycast / Alfred / iOS 快捷指令官方模板
- [ ] API key 体系（限高频用户）
- [ ] 付费层：自定义域绑定、更长 TTL、更高限额

### ❌ 不要做的陷阱

- 富文本编辑器、图片上传、多人协作 → 偏离 "小而锋利"，变成半吊子 Notion
- 账号体系 → 毁掉核心价值
- 追 DAU，而应追 NPS / 技术圈口碑

## 六、一句话总结

> **一个 100 行 JavaScript 能打动工具党的产品**。当前有两个商业级炸弹（过期 + 开放重定向）必须拆，然后就是值得继续打磨的小而美 side project。如果只是自用/朋友圈内用，现状就挺好；想做公共服务，P0 三项不做不能对外推广。
