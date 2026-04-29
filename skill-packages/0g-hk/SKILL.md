---
name: 0g-hk
description: Use when the user wants a 0g.hk / og temporary public link, paste, Markdown note, code or prompt share, semantic short URL, curl-readable raw note, or wants to list, edit, renew, or recover local edit info for prior 0g.hk links. Do not use for permanent hosting, private access control, collaborative docs, SLA-backed publishing, or content over 8KB.
---

# 0g.hk

0g.hk is the user's temporary public note and short-link service. Keep this
skill as routing and safety guidance; do not mirror the full API here.

Truth sources:
- Live agent manual: `https://0g.hk/llms.txt`
- Repo docs: `/Users/envvar/work/repos/poke/0ghk/docs/API.md`
- Product code: `/Users/envvar/work/repos/poke/0ghk`

Rules:
- Create in JSON/form mode, share `shortUrl`, and use `rawUrl` for agents or scripts.
- Save `editToken` immediately when the user may edit or renew later.
- Store local history in `~/.local/share/0g-hk/links.jsonl`; also read the legacy `~/.agents/skills/0g-hk/links.jsonl` if it exists. Keep mode `600`.
- Treat `editToken`, `editPath`, and `editUrl` as secrets. Do not expose them publicly unless the user explicitly wants an editable entry.
- Prefer JSON body edits/renewals with `{ "token": "..." }`; query `?edit=` is compatibility only.
- If curl gets a Cloudflare challenge, use the browser UI and verify the resulting public URL.
- Do not commit `links.jsonl`, copied tokens, or generated local history.

Local ledger:
- Append-only JSONL.
- On create, record `event`, `name`, `short_url`, `raw_url`, `edit_token`, `edit_url`, `ttl`, `expires_at`, `title`, `source`, and `recorded_at`.
- On edit or renew, append a new event instead of overwriting prior rows.
