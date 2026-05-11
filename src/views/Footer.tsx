// Bottom-of-page footer with brand link, abuse mailto, llms.txt, and a GitHub
// icon. Matches the legacy footerHtml() output one-to-one.
import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { BASE_HOST, ABUSE_EMAIL } from "../constants.js";

const GITHUB_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true" style="vertical-align:-2px;margin-right:3px"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

const HOME = "https://" + BASE_HOST + "/";
const LLMS = "https://" + BASE_HOST + "/llms.txt";
const MAILTO = "mailto:" + ABUSE_EMAIL;

export const Footer: FC = () => (
  <div class="wrap" style="margin-top:24px">
    <p class="faint" style="text-align:center">
      <a class="faint" href={HOME} style="color:inherit">{BASE_HOST}</a> · {' '}
      <a class="faint" href={MAILTO} style="color:inherit">举报</a> · {' '}
      <a class="faint" href={LLMS} style="color:inherit">llms.txt</a> · {' '}
      <a
        class="faint"
        href="https://github.com/catoncat/0g-hk"
        rel="noopener"
        target="_blank"
        aria-label="GitHub 仓库"
        title="GitHub"
        style="color:inherit;text-decoration:none"
      >{raw(GITHUB_SVG)}GitHub</a>
    </p>
  </div>
);
