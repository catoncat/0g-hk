---
name: 0g-hk
description: Use when the user wants a 0g.hk / og temporary public link, paste, Markdown note, code or prompt share, semantic short URL, curl-readable raw note, or wants to list, edit, renew, or find locally saved edit credentials for prior 0g.hk links. Do not use for permanent hosting, private access control, collaborative docs, SLA-backed publishing, or content over the configured limit (24KB by default; tunable in /admin/config).
---

# 0g.hk

0g.hk is a temporary public note and short-link service. Keep this skill as
routing and safety guidance; do not mirror the full API here. This package is
publicly installable, so do not assume a local checkout path.

Truth sources:
- Live agent manual: `https://0g.hk/llms.txt`
- Source repository: `https://github.com/catoncat/0g-hk`
- When working inside the source checkout, prefer the repo's `docs/API.md`

Companion tool:
- Use `scripts/0ghk-history.mjs` when the user wants to browse, search, edit, open, copy, or renew locally saved publication history. It reads `${XDG_DATA_HOME:-$HOME/.local/share}/0g-hk/links.jsonl` and never prints edit tokens.

Rules:
- Create in JSON/form mode, share `shortUrl`, and use `rawUrl` for agents or scripts.
- Save `editToken` immediately when the user may edit or renew later.
- If local edit history is needed, store it outside the installed skill package, for example `${XDG_DATA_HOME:-$HOME/.local/share}/0g-hk/links.jsonl`. Keep mode `600`.
- Treat `editToken`, `editPath`, and `editUrl` as secrets. Do not expose them publicly unless the user explicitly wants an editable entry.
- Prefer JSON body edits/renewals with `{ "token": "..." }`; query `?edit=` is compatibility only.
- If curl gets a Cloudflare challenge, use the browser UI and verify the resulting public URL.
- Do not commit `links.jsonl`, copied tokens, or generated local history.

Lost edit token / web-created notes:
- First search the local ledger with `scripts/0ghk-history.mjs --list --search <name>`; web-created notes often have no local ledger entry.
- For live 0g.hk production, verify the Worker/KV truth from the source checkout before touching data: `wrangler.toml` gives the Worker account and `NOTES` namespace, and current code stores note bodies at `n:<name>` plus metadata at `m:<name>`.
- The original edit token cannot be recovered from KV. Metadata stores only a hash (`m:<name>.h`), TTL key (`t`), and created/renewed timestamp (`ct`).
- If the user owns the deployment and explicitly asks to recover access, use the Cloudflare ops lane (`cf-ops` / `wrangler`) to read only `m:<name>` and `n:<name>`, confirm the note exists, then reset access by writing a fresh token hash into `m:<name>` while preserving `t`, `ct`, and the remaining KV expiration. Do not dump unrelated KV keys.
- Return only the new `https://<name>.0g.hk/edit#t=<token>` link to the authorized user. Do not log the token into tracked files, memory, or public docs.

Local ledger:
- Append-only JSONL.
- On create, record `event`, `name`, `short_url`, `raw_url`, `edit_token`, `edit_url`, `ttl`, `expires_at`, `title`, `source`, and `recorded_at`.
- On edit or renew, append a new event instead of overwriting prior rows.
