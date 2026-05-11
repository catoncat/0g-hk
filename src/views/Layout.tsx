// Shared <html> shell used by every JSX page. Inline COMMON_CSS + an optional
// per-page extra CSS block, both injected via raw() so we don't re-escape the
// CSS the rest of the app expects. Keep this dumb: every page passes its own
// <head> extras (title, theme meta, etc.) and an optional body class.
import type { FC, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";
import { COMMON_CSS } from "../responses.js";

type LayoutProps = PropsWithChildren<{
  title: string;
  // Per-page extra CSS appended after COMMON_CSS, in the same <style> tag.
  extraCss?: string;
  // Inline <script> body for pages that need behavior. Injected verbatim.
  inlineScript?: string;
  // Extra <meta>/<link> elements (theme-color, description, etc.).
  headExtras?: any;
  // class attribute on <body>.
  bodyClass?: string;
  // robots: noindex meta is opt-in (editor doesn't add it; note/edit/404 do).
  noindex?: boolean;
  // viewport-fit=cover variant for the home/editor page.
  fullViewport?: boolean;
}>;

export const Layout: FC<LayoutProps> = ({
  title,
  extraCss,
  inlineScript,
  headExtras,
  bodyClass,
  noindex,
  fullViewport,
  children,
}) => {
  const viewport = fullViewport
    ? "width=device-width,initial-scale=1,viewport-fit=cover"
    : "width=device-width,initial-scale=1";
  const css = extraCss ? COMMON_CSS + "\n" + extraCss : COMMON_CSS;
  return (
    <html lang="zh">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content={viewport} />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title>{title}</title>
        {noindex ? <meta name="robots" content="noindex" /> : null}
        {headExtras}
        <style>{raw(css)}</style>
      </head>
      <body class={bodyClass}>
        {children}
        {inlineScript ? <script>{raw(inlineScript)}</script> : null}
      </body>
    </html>
  );
};

// Convenience: build the final HTML string with a leading doctype.
export function renderDoc(node: any): string {
  return "<!DOCTYPE html>\n" + String(node);
}
