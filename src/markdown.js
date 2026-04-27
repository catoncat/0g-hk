import { esc } from "./util.js";

function safeHref(href) {
  const h = String(href || "").trim();
  if (/^(https?:\/\/|mailto:)/i.test(h)) return h;
  if (h.startsWith("/") && !h.startsWith("//")) return h;
  if (h.startsWith("#")) return h;
  return null;
}

function hold(tokens, html) {
  const id = tokens.length;
  tokens.push(html);
  return "\u0000MD" + id + "\u0000";
}

function restoreTokens(html, tokens) {
  return html.replace(/\u0000MD(\d+)\u0000/g, function (_, id) {
    return tokens[Number(id)] || "";
  });
}

export function renderMarkdownInline(input) {
  const tokens = [];
  let text = String(input || "");

  text = text.replace(/`([^`\n]+)`/g, function (_, code) {
    return hold(tokens, "<code>" + esc(code) + "</code>");
  });

  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)/g, function (match, label, href, offset, full) {
    if (offset > 0 && full[offset - 1] === "!") return match;
    const safe = safeHref(href);
    if (!safe) return label + " (" + href + ")";
    return hold(tokens, '<a href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>");
  });

  let out = esc(text);
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^\*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return restoreTokens(out, tokens);
}

// ---- GFM-style pipe tables ----
function splitTableRow(line) {
  let s = String(line).trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && s[i + 1] === "|") {
      buf += "|";
      i++;
    } else if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  cells.push(buf.trim());
  return cells;
}

function parseAlignRow(line) {
  const trimmed = String(line).trim();
  if (trimmed.indexOf("|") === -1) return null;
  const cells = splitTableRow(trimmed);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else if (left) aligns.push("left");
    else aligns.push("");
  }
  return aligns;
}

function isTableRowLine(line) {
  const s = String(line);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "|") return true;
  }
  return false;
}

function renderTable(headerCells, aligns, rows) {
  const styleFor = function (a) {
    return a ? ' style="text-align:' + a + '"' : "";
  };
  let html = "<table><thead><tr>";
  for (let i = 0; i < headerCells.length; i++) {
    html += "<th" + styleFor(aligns[i] || "") + ">" + renderMarkdownInline(headerCells[i]) + "</th>";
  }
  html += "</tr></thead>";
  if (rows.length) {
    html += "<tbody>";
    for (const row of rows) {
      html += "<tr>";
      for (let i = 0; i < headerCells.length; i++) {
        const cell = i < row.length ? row[i] : "";
        html += "<td" + styleFor(aligns[i] || "") + ">" + renderMarkdownInline(cell) + "</td>";
      }
      html += "</tr>";
    }
    html += "</tbody>";
  }
  html += "</table>";
  return html;
}

export function renderMarkdown(source) {
  const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let quote = [];
  let listType = "";
  let listItems = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLang = "";
  let fenceLines = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    out.push("<p>" + renderMarkdownInline(paragraph.join(" ")) + "</p>");
    paragraph = [];
  }

  function flushQuote() {
    if (!quote.length) return;
    out.push("<blockquote><p>" + renderMarkdownInline(quote.join("\n")).replace(/\n/g, "<br>") + "</p></blockquote>");
    quote = [];
  }

  function flushList() {
    if (!listItems.length) return;
    out.push("<" + listType + ">" + listItems.map(function (item) {
      return "<li>" + renderMarkdownInline(item) + "</li>";
    }).join("") + "</" + listType + ">");
    listType = "";
    listItems = [];
  }

  function flushFence() {
    const cls = fenceLang ? ' class="language-' + esc(fenceLang) + '"' : "";
    out.push("<pre><code" + cls + ">" + esc(fenceLines.join("\n")) + "</code></pre>");
    inFence = false;
    fenceChar = "";
    fenceLang = "";
    fenceLines = [];
  }

  function closeLooseBlocks() {
    flushParagraph();
    flushQuote();
    flushList();
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_-]+)?\s*$/);

    if (inFence) {
      if (fence && fence[1][0] === fenceChar) flushFence();
      else fenceLines.push(raw);
      continue;
    }

    if (fence) {
      closeLooseBlocks();
      inFence = true;
      fenceChar = fence[1][0];
      fenceLang = fence[2] || "";
      fenceLines = [];
      continue;
    }

    if (!line.trim()) {
      closeLooseBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      closeLooseBlocks();
      const level = heading[1].length;
      out.push("<h" + level + ">" + renderMarkdownInline(heading[2]) + "</h" + level + ">");
      continue;
    }

    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      closeLooseBlocks();
      out.push("<hr>");
      continue;
    }

    // Table: header row | --- | --- | followed by zero or more data rows.
    if (isTableRowLine(line) && i + 1 < lines.length) {
      const sepLine = lines[i + 1].replace(/\s+$/, "");
      const aligns = parseAlignRow(sepLine);
      if (aligns) {
        const headerCells = splitTableRow(line);
        if (headerCells.length === aligns.length) {
          closeLooseBlocks();
          const rows = [];
          let j = i + 2;
          while (j < lines.length) {
            const rawRow = lines[j].replace(/\s+$/, "");
            if (!rawRow.trim()) break;
            if (!isTableRowLine(rawRow)) break;
            if (/^ {0,3}(`{3,}|~{3,})/.test(rawRow)) break;
            rows.push(splitTableRow(rawRow));
            j++;
          }
          out.push(renderTable(headerCells, aligns, rows));
          i = j - 1;
          continue;
        }
      }
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }

    const unordered = line.match(/^ {0,3}[-*+]\s+(.+)$/);
    const ordered = line.match(/^ {0,3}\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered || ordered)[1]);
      continue;
    }

    flushQuote();
    flushList();
    paragraph.push(line.trim());
  }

  if (inFence) flushFence();
  closeLooseBlocks();
  return out.join("\n");
}
