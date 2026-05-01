#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const VERSION = "0.1.0";
const BASE_HOST = process.env.OGHK_BASE_HOST || "0g.hk";
const DEFAULT_LEDGER = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "0g-hk", "links.jsonl");

const HELP = `0ghk-history ${VERSION}

Manage the local 0g.hk publication ledger without adding server-side admin UI.
Secrets stay local: edit tokens/URLs are never printed; copy/open actions use them directly.

Usage:
  0ghk-history [--ledger PATH]
  0ghk-history --list [--ledger PATH] [--search TEXT] [--show-events]
  0ghk-history --json [--ledger PATH] [--search TEXT] [--show-events]
  0ghk-history --renew NAME [--ttl 1h|1d|7d] [--dry-run] [--ledger PATH]
  0ghk-history --open short|raw|edit NAME [--ledger PATH]
  0ghk-history --copy short|raw|edit NAME [--ledger PATH]

TUI keys:
  j/k, ↑/↓        move
  /               search names, titles, sources
  a               toggle latest publications / every ledger event
  r               renew selected publication (confirm with y)
  o / O           open shortUrl / rawUrl
  e               open edit URL (local browser, sensitive)
  c / R / E       copy shortUrl / rawUrl / edit URL
  ?               help
  esc             clear search, message, or confirmation
  q               quit

Ledger:
  default: ${DEFAULT_LEDGER}
  override: --ledger PATH or OGHK_LEDGER=PATH
`;

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseArgs(argv) {
  const args = {
    ledger: process.env.OGHK_LEDGER || DEFAULT_LEDGER,
    search: "",
    list: false,
    json: false,
    showEvents: false,
    renew: "",
    ttl: "",
    dryRun: false,
    open: null,
    copy: null,
    help: false,
    version: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a === "--ledger") args.ledger = argv[++i] || "";
    else if (a.startsWith("--ledger=")) args.ledger = a.slice("--ledger=".length);
    else if (a === "--search" || a === "-s") args.search = argv[++i] || "";
    else if (a.startsWith("--search=")) args.search = a.slice("--search=".length);
    else if (a === "--list") args.list = true;
    else if (a === "--json") args.json = true;
    else if (a === "--show-events") args.showEvents = true;
    else if (a === "--renew") args.renew = argv[++i] || "";
    else if (a.startsWith("--renew=")) args.renew = a.slice("--renew=".length);
    else if (a === "--ttl") args.ttl = argv[++i] || "";
    else if (a.startsWith("--ttl=")) args.ttl = a.slice("--ttl=".length);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--open") args.open = { kind: argv[++i] || "", name: argv[++i] || "" };
    else if (a.startsWith("--open=")) args.open = { kind: a.slice("--open=".length), name: argv[++i] || "" };
    else if (a === "--copy") args.copy = { kind: argv[++i] || "", name: argv[++i] || "" };
    else if (a.startsWith("--copy=")) args.copy = { kind: a.slice("--copy=".length), name: argv[++i] || "" };
    else rest.push(a);
  }
  if (args.open && !args.open.name && rest.length) args.open.name = rest.shift();
  if (args.copy && !args.copy.name && rest.length) args.copy.name = rest.shift();
  args.ledger = expandHome(args.ledger || DEFAULT_LEDGER);
  return args;
}

function readLedger(file) {
  const rows = [];
  const errors = [];
  if (!fs.existsSync(file)) return { rows, errors, missing: true };
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(normalizeRow(JSON.parse(line), i + 1));
    } catch (err) {
      errors.push({ line: i + 1, message: String(err && err.message ? err.message : err) });
    }
  }
  return { rows, errors, missing: false };
}

function normalizeRow(raw, lineNo) {
  const name = str(raw.name);
  const shortUrl = str(raw.short_url || raw.shortUrl || (name ? `https://${name}.${BASE_HOST}` : ""));
  const rawUrl = str(raw.raw_url || raw.rawUrl || (shortUrl ? `${shortUrl}/raw` : ""));
  const editToken = str(raw.edit_token || raw.editToken || tokenFromEditUrl(raw.edit_url || raw.editUrl));
  const editUrl = str(raw.edit_url || raw.editUrl || (shortUrl && editToken ? `${shortUrl}/edit#t=${editToken}` : ""));
  return {
    lineNo,
    raw,
    event: str(raw.event || "event"),
    name,
    title: str(raw.title),
    source: str(raw.source),
    kind: str(raw.kind),
    note: str(raw.note),
    shortUrl,
    rawUrl,
    editToken,
    editUrl,
    ttl: str(raw.ttl),
    createdAt: str(raw.created_at || raw.createdAt),
    expiresAt: str(raw.expires_at || raw.expiresAt),
    recordedAt: str(raw.recorded_at || raw.recordedAt),
    contentLength: numberish(raw.content_length || raw.contentLength),
    target: str(raw.target),
  };
}

function tokenFromEditUrl(url) {
  const s = str(url);
  const m = s.match(/[#&?]t=([^&#]+)/);
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function str(v) {
  return v == null ? "" : String(v);
}

function numberish(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function buildPublications(rows) {
  const byName = new Map();
  for (const row of rows) {
    if (!row.name) continue;
    let entry = byName.get(row.name);
    if (!entry) {
      entry = {
        type: "publication",
        name: row.name,
        title: "",
        source: "",
        kind: "",
        shortUrl: "",
        rawUrl: "",
        editToken: "",
        editUrl: "",
        ttl: "",
        createdAt: "",
        expiresAt: "",
        recordedAt: "",
        contentLength: null,
        target: "",
        lastEvent: "",
        lineNo: row.lineNo,
        events: [],
      };
      byName.set(row.name, entry);
    }
    entry.events.push(row);
    entry.lineNo = row.lineNo;
    entry.lastEvent = row.event || entry.lastEvent;
    for (const k of ["title", "source", "kind", "shortUrl", "rawUrl", "ttl", "createdAt", "expiresAt", "recordedAt", "target"]) {
      if (row[k]) entry[k] = row[k];
    }
    if (row.contentLength != null) entry.contentLength = row.contentLength;
    if (row.editToken) entry.editToken = row.editToken;
    if (row.editUrl) entry.editUrl = row.editUrl;
  }
  return [...byName.values()].sort(compareEntries);
}

function buildEventEntries(rows) {
  return rows.map((row) => ({
    type: "event",
    name: row.name,
    title: row.title,
    source: row.source,
    kind: row.kind,
    shortUrl: row.shortUrl,
    rawUrl: row.rawUrl,
    editToken: row.editToken,
    editUrl: row.editUrl,
    ttl: row.ttl,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    recordedAt: row.recordedAt,
    contentLength: row.contentLength,
    target: row.target,
    lastEvent: row.event,
    lineNo: row.lineNo,
    events: [row],
  })).sort(compareEntries);
}

function compareEntries(a, b) {
  const at = Date.parse(a.expiresAt || a.recordedAt || a.createdAt || "") || 0;
  const bt = Date.parse(b.expiresAt || b.recordedAt || b.createdAt || "") || 0;
  return bt - at || String(a.name).localeCompare(String(b.name));
}

function filterEntries(entries, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => [e.name, e.title, e.source, e.kind, e.lastEvent, e.shortUrl].join("\n").toLowerCase().includes(needle));
}

function isExpired(expiresAt) {
  const t = Date.parse(expiresAt || "");
  return Number.isFinite(t) && t <= Date.now();
}

function timeStatus(expiresAt) {
  const t = Date.parse(expiresAt || "");
  if (!Number.isFinite(t)) return "unknown";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const mins = Math.floor((abs % 3600000) / 60000);
  const body = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  return diff < 0 ? `expired ${body} ago` : `${body} left`;
}

function safeEntry(e) {
  return {
    type: e.type,
    name: e.name,
    title: e.title || undefined,
    source: e.source || undefined,
    kind: e.kind || undefined,
    short_url: e.shortUrl || undefined,
    raw_url: e.rawUrl || undefined,
    has_edit_token: Boolean(e.editToken),
    has_edit_url: Boolean(e.editUrl),
    ttl: e.ttl || undefined,
    created_at: e.createdAt || undefined,
    expires_at: e.expiresAt || undefined,
    recorded_at: e.recordedAt || undefined,
    content_length: e.contentLength == null ? undefined : e.contentLength,
    last_event: e.lastEvent || undefined,
    event_count: e.events.length,
    expired: isExpired(e.expiresAt),
  };
}

function printList(entries) {
  if (!entries.length) {
    console.log("No 0g.hk ledger entries matched.");
    return;
  }
  const rows = entries.map((e) => ({
    name: e.name,
    event: e.lastEvent,
    ttl: e.ttl || "-",
    expires: e.expiresAt ? timeStatus(e.expiresAt) : "-",
    editable: e.editToken || e.editUrl ? "yes" : "no",
    title: e.title || e.source || "",
  }));
  const widths = {
    name: Math.min(32, Math.max(4, ...rows.map((r) => r.name.length))),
    event: Math.min(10, Math.max(5, ...rows.map((r) => r.event.length))),
    ttl: Math.min(5, Math.max(3, ...rows.map((r) => r.ttl.length))),
    expires: Math.min(18, Math.max(7, ...rows.map((r) => r.expires.length))),
  };
  console.log(`${pad("name", widths.name)}  ${pad("event", widths.event)}  ${pad("ttl", widths.ttl)}  ${pad("expires", widths.expires)}  edit  title/source`);
  for (const r of rows) {
    console.log(`${pad(r.name, widths.name)}  ${pad(r.event, widths.event)}  ${pad(r.ttl, widths.ttl)}  ${pad(r.expires, widths.expires)}  ${pad(r.editable, 4)}  ${r.title}`);
  }
}

function pad(s, n) {
  s = str(s);
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s + " ".repeat(Math.max(0, n - s.length));
}

function pickEntry(entries, name) {
  const exact = entries.find((e) => e.name === name);
  if (exact) return exact;
  const partial = entries.filter((e) => e.name.includes(name));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`ambiguous name '${name}': ${partial.map((e) => e.name).join(", ")}`);
  throw new Error(`not found in local ledger: ${name}`);
}

function urlFor(entry, kind) {
  if (kind === "short") return entry.shortUrl;
  if (kind === "raw") return entry.rawUrl;
  if (kind === "edit") return entry.editUrl;
  throw new Error(`unknown url kind: ${kind}`);
}

function openUrl(url) {
  if (!url) throw new Error("missing URL");
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.unref();
}

function copyText(text) {
  if (!text) throw new Error("nothing to copy");
  const candidates = process.platform === "darwin" ? [["pbcopy", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, args, { input: text, encoding: "utf8" });
    if (!r.error && r.status === 0) return cmd;
  }
  throw new Error("no clipboard command found (pbcopy/wl-copy/xclip/xsel)");
}

async function renewEntry(entry, opts) {
  const token = entry.editToken || tokenFromEditUrl(entry.editUrl);
  if (!token) throw new Error(`${entry.name} has no saved edit token`);
  const ttl = opts.ttl || entry.ttl || "";
  if (ttl && !["1h", "1d", "7d"].includes(ttl)) throw new Error(`invalid ttl: ${ttl}`);
  const url = entry.shortUrl || `https://${entry.name}.${BASE_HOST}`;
  const body = { token, renew: true };
  if (ttl) body.ttl = ttl;
  if (opts.dryRun) {
    return { dryRun: true, request: { url, body: { ...body, token: "<redacted>" } } };
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!response.ok) {
    const code = json && json.error && json.error.code ? json.error.code : response.status;
    throw new Error(`renew failed for ${entry.name}: ${code}`);
  }
  return json || { ok: true, text };
}

function appendRenewEvent(file, entry, result, ttl) {
  const now = new Date().toISOString();
  const row = {
    event: "renewed",
    name: entry.name,
    short_url: result.shortUrl || result.short_url || entry.shortUrl,
    raw_url: result.rawUrl || result.raw_url || entry.rawUrl,
    ttl: result.ttl || ttl || entry.ttl,
    expires_at: result.expiresAt || result.expires_at || entry.expiresAt,
    content_length: result.contentLength || result.content_length || entry.contentLength || undefined,
    note: "renewed by 0ghk-history tui",
    recorded_at: now,
  };
  for (const k of Object.keys(row)) if (row[k] === undefined || row[k] === "") delete row[k];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "", { mode: 0o600 });
  }
  fs.appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
}

function makeState(ledgerFile, initialRows, errors) {
  return {
    ledgerFile,
    rows: initialRows,
    parseErrors: errors,
    showEvents: false,
    search: "",
    cursor: 0,
    message: "",
    confirm: null,
    help: false,
  };
}

function currentEntries(state) {
  const source = state.showEvents ? buildEventEntries(state.rows) : buildPublications(state.rows);
  return filterEntries(source, state.search);
}

function currentEntry(state) {
  const entries = currentEntries(state);
  if (!entries.length) return null;
  if (state.cursor >= entries.length) state.cursor = entries.length - 1;
  if (state.cursor < 0) state.cursor = 0;
  return entries[state.cursor];
}

function runTui(ledgerFile, rows, errors) {
  const state = makeState(ledgerFile, rows, errors);
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) {
    printList(currentEntries(state));
    return;
  }
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  const cleanup = () => {
    stdout.write("\x1b[?25h\x1b[0m\n");
    if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
    stdin.pause();
  };
  const rerender = () => render(stdout, state);
  const exit = () => { cleanup(); process.exit(0); };
  stdin.on("data", async (buf) => {
    const key = decodeKey(buf);
    try {
      if (state.confirm) {
        if (key === "y" || key === "Y") {
          const action = state.confirm;
          state.confirm = null;
          state.message = "Working…";
          rerender();
          await action.run();
        } else if (key === "escape" || key === "q" || key === "n") {
          state.confirm = null;
          state.message = "Cancelled";
        }
        rerender();
        return;
      }
      if (state.searchMode) {
        if (key === "escape") { state.searchMode = false; state.message = ""; }
        else if (key === "enter") { state.searchMode = false; }
        else if (key === "backspace") { state.search = state.search.slice(0, -1); state.cursor = 0; }
        else if (key.length === 1 && key >= " ") { state.search += key; state.cursor = 0; }
        rerender();
        return;
      }
      if (state.help && key !== "?" && key !== "escape" && key !== "q") return;
      if (key === "ctrl+c") exit();
      else if (key === "q") exit();
      else if (key === "?" ) state.help = !state.help;
      else if (key === "escape") { state.search = ""; state.message = ""; state.help = false; }
      else if (key === "/") { state.searchMode = true; state.message = "Type search, enter to keep, esc to cancel"; }
      else if (key === "a") { state.showEvents = !state.showEvents; state.cursor = 0; }
      else if (key === "j" || key === "down") state.cursor = Math.min(state.cursor + 1, Math.max(0, currentEntries(state).length - 1));
      else if (key === "k" || key === "up") state.cursor = Math.max(0, state.cursor - 1);
      else if (key === "g") state.cursor = 0;
      else if (key === "G") state.cursor = Math.max(0, currentEntries(state).length - 1);
      else if (["o", "O", "e", "c", "R", "E", "r"].includes(key)) await handleActionKey(key, state);
      rerender();
    } catch (err) {
      state.message = String(err && err.message ? err.message : err);
      rerender();
    }
  });
  stdout.write("\x1b[?25l");
  rerender();
}

function decodeKey(buf) {
  const s = buf.toString("utf8");
  if (s === "\u0003") return "ctrl+c";
  if (s === "\r" || s === "\n") return "enter";
  if (s === "\u007f" || s === "\b") return "backspace";
  if (s === "\u001b") return "escape";
  if (s === "\u001b[A") return "up";
  if (s === "\u001b[B") return "down";
  return s;
}

async function handleActionKey(key, state) {
  const entry = currentEntry(state);
  if (!entry) { state.message = "No selected entry"; return; }
  if (key === "o" || key === "O" || key === "e") {
    const kind = key === "O" ? "raw" : key === "e" ? "edit" : "short";
    const url = urlFor(entry, kind);
    if (!url) throw new Error(`missing ${kind} URL for ${entry.name}`);
    openUrl(url);
    state.message = kind === "edit" ? "Opened local edit URL (secret not printed)" : `Opened ${kind} URL`;
    return;
  }
  if (key === "c" || key === "R" || key === "E") {
    const kind = key === "R" ? "raw" : key === "E" ? "edit" : "short";
    const url = urlFor(entry, kind);
    if (!url) throw new Error(`missing ${kind} URL for ${entry.name}`);
    if (kind === "edit") {
      state.confirm = { text: `Copy sensitive edit URL for ${entry.name}? y/N`, run: async () => {
        copyText(url);
        state.message = "Copied sensitive edit URL (value not printed)";
      } };
    } else {
      copyText(url);
      state.message = `Copied ${kind} URL`;
    }
    return;
  }
  if (key === "r") {
    state.confirm = { text: `Renew ${entry.name} with ttl ${entry.ttl || "current"}? y/N`, run: async () => {
      const result = await renewEntry(entry, { ttl: entry.ttl });
      appendRenewEvent(state.ledgerFile, entry, result, result.ttl || entry.ttl);
      const reread = readLedger(state.ledgerFile);
      state.rows = reread.rows;
      state.parseErrors = reread.errors;
      state.message = `Renewed ${entry.name}`;
    } };
  }
}

function render(stdout, state) {
  const cols = Math.max(80, stdout.columns || 100);
  const rows = Math.max(20, stdout.rows || 30);
  const entries = currentEntries(state);
  const selected = entries[state.cursor] || null;
  const leftW = Math.max(34, Math.min(48, Math.floor(cols * 0.42)));
  const rightW = cols - leftW - 3;
  const bodyH = rows - 5;
  const start = Math.max(0, Math.min(state.cursor - Math.floor(bodyH / 2), Math.max(0, entries.length - bodyH)));
  const lines = [];
  lines.push(color(`0ghk-history ${VERSION}`, "bold") + `  ${entries.length} ${state.showEvents ? "events" : "publications"}  ledger: ${state.ledgerFile}`);
  lines.push(`${state.showEvents ? "all events" : "latest only"}  search: ${state.search ? color(state.search, "yellow") : "-"}  keys: ? help, / search, a events, r renew, q quit`);
  lines.push("─".repeat(cols));
  for (let i = 0; i < bodyH; i += 1) {
    const entry = entries[start + i];
    const left = entry ? renderListLine(entry, start + i === state.cursor, leftW) : " ".repeat(leftW);
    const detailLines = selected ? renderDetails(selected, rightW, bodyH) : ["No entries. Create notes through 0g.hk JSON mode and append them to the local ledger."];
    const right = detailLines[i] || "";
    lines.push(left + " │ " + padPlain(right, rightW));
  }
  lines.push("─".repeat(cols));
  const msg = state.confirm ? state.confirm.text : state.message || (state.searchMode ? "Search mode" : `${state.parseErrors.length ? `${state.parseErrors.length} parse error(s). ` : ""}Secrets are local; edit tokens are not rendered.`);
  lines.push(padPlain(msg, cols));
  if (state.help) overlayHelp(lines, cols, rows);
  stdout.write("\x1b[H\x1b[2J" + lines.slice(0, rows).join("\n"));
}

function renderListLine(e, active, width) {
  const badge = e.editToken || e.editUrl ? "🔑" : " ";
  const expired = isExpired(e.expiresAt) ? "!" : " ";
  const name = padPlain(e.name || "(unnamed)", Math.max(10, width - 18));
  const ttl = padPlain(e.ttl || "-", 3);
  const event = padPlain(e.lastEvent || "-", 8);
  const line = `${badge}${expired} ${name} ${ttl} ${event}`;
  return active ? color(padPlain(line, width), "inverse") : padPlain(line, width);
}

function renderDetails(e, width, height) {
  const lines = [];
  lines.push(color(e.name || "(unnamed)", "bold"));
  if (e.title) lines.push(wrapLine(`title: ${e.title}`, width));
  if (e.source) lines.push(wrapLine(`source: ${e.source}`, width));
  lines.push(`event: ${e.lastEvent || "-"}  ttl: ${e.ttl || "-"}  editable: ${e.editToken || e.editUrl ? "yes" : "no"}`);
  lines.push(`expires: ${e.expiresAt || "-"} (${timeStatus(e.expiresAt)})`);
  if (e.recordedAt) lines.push(`recorded: ${e.recordedAt}`);
  if (e.contentLength != null) lines.push(`content_length: ${e.contentLength}`);
  if (e.kind) lines.push(`kind: ${e.kind}`);
  if (e.target) lines.push(wrapLine(`target: ${e.target}`, width));
  if (e.shortUrl) lines.push(wrapLine(`short: ${e.shortUrl}`, width));
  if (e.rawUrl) lines.push(wrapLine(`raw:   ${e.rawUrl}`, width));
  if (e.editUrl) lines.push("edit:  <saved locally; press e to open or E to copy>");
  lines.push("");
  lines.push(color("history", "bold"));
  for (const row of [...e.events].slice(-Math.max(3, height - lines.length - 1)).reverse()) {
    const when = row.recordedAt || row.createdAt || "-";
    const note = row.note ? ` — ${row.note}` : "";
    lines.push(wrapLine(`#${row.lineNo} ${row.event || "event"} ${when}${note}`, width));
  }
  return lines.flatMap((line) => Array.isArray(line) ? line : [line]).slice(0, height).map((line) => padAnsi(line, width));
}

function wrapLine(text, width) {
  const chunks = [];
  let s = text;
  while (plainLength(s) > width) {
    chunks.push(s.slice(0, width - 1) + "…");
    s = "  " + s.slice(width - 1);
  }
  chunks.push(s);
  return chunks;
}

function overlayHelp(lines, cols, rows) {
  const box = [
    " 0ghk-history help ",
    " j/k ↑/↓ move       / search        a latest/events ",
    " r renew selected   o open short    O open raw ",
    " e open edit URL    c copy short    R copy raw ",
    " E copy edit URL    esc clear       q quit ",
    " Edit tokens and edit URLs are never printed. ",
  ];
  const w = Math.min(cols - 4, Math.max(...box.map(plainLength)) + 4);
  const x = Math.max(0, Math.floor((cols - w) / 2));
  const y = Math.max(3, Math.floor((rows - box.length) / 3));
  for (let i = 0; i < box.length; i += 1) {
    const line = color("╭" + "─".repeat(w - 2) + "╮", "inverse");
    const mid = color("│" + padPlain(box[i], w - 2) + "│", "inverse");
    const bot = color("╰" + "─".repeat(w - 2) + "╯", "inverse");
    lines[y - 1] = spliceAt(lines[y - 1] || "", x, line);
    lines[y + i] = spliceAt(lines[y + i] || "", x, mid);
    lines[y + box.length] = spliceAt(lines[y + box.length] || "", x, bot);
  }
}

function spliceAt(line, x, insert) {
  return padPlain(line, x).slice(0, x) + insert;
}

function padPlain(s, n) {
  s = str(s);
  const len = plainLength(s);
  if (len > n) return truncatePlain(s, n);
  return s + " ".repeat(n - len);
}

function padAnsi(s, n) {
  return padPlain(s, n);
}

function truncatePlain(s, n) {
  if (n <= 1) return "";
  // This script keeps colored strings short and truncates before applying color in most paths.
  const plain = stripAnsi(s);
  return plain.length > n ? plain.slice(0, n - 1) + "…" : plain;
}

function plainLength(s) { return stripAnsi(str(s)).length; }
function stripAnsi(s) { return str(s).replace(/\x1b\[[0-9;]*m/g, ""); }

function color(s, kind) {
  const codes = { bold: [1, 22], inverse: [7, 27], yellow: [33, 39], red: [31, 39], green: [32, 39] }[kind];
  if (!codes || process.env.NO_COLOR) return s;
  return `\x1b[${codes[0]}m${s}\x1b[${codes[1]}m`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (args.version) { console.log(VERSION); return; }

  const ledger = readLedger(args.ledger);
  const publications = buildPublications(ledger.rows);
  const entries = filterEntries(args.showEvents ? buildEventEntries(ledger.rows) : publications, args.search);

  if (args.json) {
    console.log(JSON.stringify({ ledger: args.ledger, missing: ledger.missing, parse_errors: ledger.errors, entries: entries.map(safeEntry) }, null, 2));
    return;
  }
  if (args.list) {
    printList(entries);
    if (ledger.errors.length) console.error(`parse errors: ${ledger.errors.length}`);
    return;
  }
  if (args.renew) {
    const entry = pickEntry(publications, args.renew);
    const result = await renewEntry(entry, { ttl: args.ttl, dryRun: args.dryRun });
    if (!args.dryRun) appendRenewEvent(args.ledger, entry, result, args.ttl || entry.ttl);
    console.log(JSON.stringify(args.dryRun ? result : { ok: true, name: entry.name, ttl: result.ttl || args.ttl || entry.ttl, expires_at: result.expiresAt || result.expires_at }, null, 2));
    return;
  }
  if (args.open) {
    const entry = pickEntry(publications, args.open.name);
    openUrl(urlFor(entry, args.open.kind));
    console.log(args.open.kind === "edit" ? "opened edit URL (secret not printed)" : `opened ${args.open.kind} URL for ${entry.name}`);
    return;
  }
  if (args.copy) {
    const entry = pickEntry(publications, args.copy.name);
    copyText(urlFor(entry, args.copy.kind));
    console.log(args.copy.kind === "edit" ? "copied edit URL (secret not printed)" : `copied ${args.copy.kind} URL for ${entry.name}`);
    return;
  }
  runTui(args.ledger, ledger.rows, ledger.errors);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
