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

export const ABUSE_AUTO_DISABLE = 3;
export const ABUSE_EMAIL = "abuse@0g.hk";

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const TEXT_MAX = 8 * 1024;
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
