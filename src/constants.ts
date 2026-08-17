// Shared constants. No runtime deps.

export const BASE_HOST = "0g.hk";

export const RESERVED = new Set([
  // system paths
  "www", "api", "new", "admin", "edit", "raw", "n", "app", "abuse", "report", "exists",
  "mail", "email", "dns", "mx", "ns", "cdn", "static", "assets", "help", "docs", "status",
]);

// Substrings (case-insensitive) that indicate brand squatting / phishing intent.
export const BRAND_BLOCK = [
  "apple", "icloud", "itunes", "appstore",
  "google", "gmail", "youtube",
  "microsoft", "office365", "outlook", "hotmail", "onedrive", "xbox",
  "facebook", "instagram", "whatsapp",
  "amazon", "netflix", "spotify", "disney", "linkedin",
  "paypal", "stripe", "venmo", "cashapp", "zelle",
  "visa", "mastercard", "amex",
  "chase", "wellsfargo", "hsbc", "barclays", "citibank", "santander",
  "binance", "coinbase", "kraken", "kucoin", "huobi", "bybit", "okex",
  "metamask", "trustwallet", "phantom", "ledger", "trezor", "uniswap",
  "usdt", "usdc",
  "alipay", "zhifubao", "taobao", "tmall", "jingdong", "pinduoduo",
  "wechat", "weixin", "tencent", "douyin", "tiktok", "alibaba",
  "openai", "chatgpt", "anthropic", "midjourney",
  "login", "signin", "signup", "verify", "verification", "confirm",
  "secure", "support", "billing", "account", "unlock", "suspended",
  "password", "recovery", "wallet",
  "usps", "fedex", "dhl",
  "dropbox", "discord", "telegram",
];

// Known URL shorteners / redirect services — blocked as redirect targets.
export const SHORTENER_HOSTS = new Set([
  "bit.ly", "t.co", "tinyurl.com", "goo.gl", "is.gd", "ow.ly", "buff.ly",
  "cutt.ly", "rebrand.ly", "short.io", "rb.gy", "shorturl.at", "lnkd.in",
  "tiny.cc", "t.ly", "x.gd", "v.gd", "s.id", "t2m.io", "bl.ink",
  "0g.hk",
]);

// --- Abuse reporting (D3) --------------------------------------------------
//
// Number of DISTINCT REPORTER GROUPS (one IPv6 /64 or one IPv4 /24, see
// reporterGroup()) that must report a name before the automatic action fires.
//
// THRESHOLD RATIONALE. After group collapsing, one unit of `abuse:<name>` costs
// the reporter one distinct /64 or /24 *and* one solved challenge. That makes 10
// the right order of magnitude from both directions:
//   - high enough that a single residential delegation no longer buys a
//     takedown cheaply. Such a delegation is typically a /56 or /48, i.e.
//     256–65536 /64s, so before collapsing the old threshold of 3 was reachable
//     from one subscriber line (1.10, 1.11);
//   - low enough that a genuinely abused link still trips well within a day of
//     real reports, which is all the lifetime a note can have anyway (max 7d).
// The previous constant `ABUSE_AUTO_DISABLE = 3` is REMOVED rather than aliased,
// so nothing can keep counting against the old bound by accident.
export const ABUSE_AUTO_QUARANTINE = 10;
// Bounds on the automatic quarantine marker's lifetime (2.16). The window is
// the note's OWN remaining TTL, clamped into [min, max] — so the marker can
// never outlive the content it protects by more than a note lifetime, which is
// what replaces the old 365-day hard disable (1.13).
export const QUARANTINE_MAX_TTL_SEC = 7 * 86400; // == the longest note TTL
export const QUARANTINE_MIN_TTL_SEC = 3600; // == the shortest note TTL
// `abuse:<name>` counter TTL, and now the dedupe key's TTL too: one reporter
// group counts at most once per note per COUNTER lifetime, which is what makes
// ABUSE_AUTO_QUARANTINE mean "10 distinct ranges" (2.17).
export const ABUSE_GROUP_TTL_SEC = 30 * 86400;
export const ABUSE_EMAIL = "abuse@0g.hk";

export const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Defaults; runtime overrides live in KV via src/config.js (admin /admin/config UI).
export const TEXT_MAX = 24 * 1024;
export const URL_MAX = 2 * 1024;
export const RATE_LIMIT = 10;

// Adaptive rate limiter thresholds.
export const ADAPTIVE_REJECT_THRESHOLD = 5;
export const ADAPTIVE_RATE_LIMIT = 2;

export const TTL_OPTIONS = {
  "1h": 3600,
  "1d": 86400,
  "7d": 7 * 86400,
};
export const DEFAULT_TTL = "7d";

export const REDIRECT_ALLOWLIST = [
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

export const API_VERSION = 1;

// Rejection codes tracked by recordReject (admin stats).
export const REJECT_CODES = [
  "brand_blocked",
  "bad_scheme",
  "shortener_blocked",
  "unsafe_target",
  "content_blocked",
];
