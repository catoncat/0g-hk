---
name: 0g-hk
description: Use when the user wants a 0g.hk / og temporary public link, paste, Markdown note, code or prompt share, semantic short URL, curl-readable raw note, or wants to list, edit, renew, or find locally saved edit credentials for prior 0g.hk links. Do not use for permanent hosting, private access control, collaborative docs, SLA-backed publishing, or content over 8KB.
---

# 0g.hk

0g.hk is a temporary public note and short-link service. Keep this skill as
routing and safety guidance; do not mirror the full API here. This package is
publicly installable, so do not assume a local checkout path.

Truth sources:
- Live agent manual: `https://0g.hk/llms.txt`
- Source repository: `https://github.com/catoncat/0g-hk`
- When working inside the source checkout, prefer the repo's `docs/API.md`

Rules:
- Create in JSON/form mode, share `shortUrl`, and use `rawUrl` for agents or scripts.
- Save `editToken` immediately when the user may edit or renew later.
- If local edit history is needed, store it outside the installed skill package, for example `${XDG_DATA_HOME:-$HOME/.local/share}/0g-hk/links.jsonl`. Keep mode `600`.
- Treat `editToken`, `editPath`, and `editUrl` as secrets. Do not expose them publicly unless the user explicitly wants an editable entry.
- Prefer JSON body edits/renewals with `{ "token": "..." }`; query `?edit=` is compatibility only.
- If curl gets a Cloudflare challenge, use the browser UI and verify the resulting public URL.
- Do not commit `links.jsonl`, copied tokens, or generated local history.

Local ledger:
- Append-only JSONL.
- On create, record `event`, `name`, `short_url`, `raw_url`, `edit_token`, `edit_url`, `ttl`, `expires_at`, `title`, `source`, and `recorded_at`.
- On edit or renew, append a new event instead of overwriting prior rows.
