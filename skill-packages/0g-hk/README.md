# 0g-hk skill companion tools

This installable skill stays small; operational details live in the repo docs and
live `llms.txt`. Companion tools here are local-only helpers for agents and
humans who want to keep edit history outside the public 0g.hk service.

## `scripts/0ghk-history.mjs`

A dependency-free Node TUI for the local publication ledger:

```bash
node ~/.agents/skills/0g-hk/scripts/0ghk-history.mjs
```

It reads the append-only ledger at:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/0g-hk/links.jsonl
```

Override with `OGHK_LEDGER` or `--ledger PATH`.

What it does:

- Lists latest publications or every ledger event.
- Searches by name, title, source, kind, event, or URL.
- Shows per-publication history without printing edit tokens.
- Marks the current row with a visible `>` selector, independent of terminal
  inverse-color support.
- Edits a publication in `$VISUAL`/`$EDITOR`, then saves it back through the
  JSON edit API and appends an `edited` event.
- Opens/copies `shortUrl`, `rawUrl`, and local `editUrl` on demand.
- Renews a publication through the JSON edit API and appends a `renewed` event.

Useful non-interactive commands:

```bash
node scripts/0ghk-history.mjs --list
node scripts/0ghk-history.mjs --json --search report
node scripts/0ghk-history.mjs --renew my-note --dry-run
node scripts/0ghk-history.mjs --edit my-note
node scripts/0ghk-history.mjs --edit my-note --content-file note.md --dry-run
node scripts/0ghk-history.mjs --open edit my-note
node scripts/0ghk-history.mjs --copy short my-note
```

Security model:

- `editToken` and `editUrl` are treated as local secrets.
- The TUI never renders those values and JSON/list output only reports whether
  a saved credential exists.
- Edit/copy/open actions may use the secret locally but do not echo it to stdout.
- The ledger file should remain mode `600`; the tool sets that mode when it
  appends edit or renew events.
