// "You can make one too" pitch card shown below rendered notes.
import type { FC } from "hono/jsx";
import { BASE_HOST } from "../constants.js";

export const Promo: FC = () => (
  <a class="promo" href={"https://" + BASE_HOST + "/"}>
    <span class="promo-t">你也能用 0g<span class="promo-dot">.</span>hk 创建一个</span>
    <span class="promo-s">复制一段文字 / 粘贴一条链接 → 生成 <code>xxx.{BASE_HOST}</code>，7 天后自毁</span>
    <span class="promo-cta">试试 →</span>
  </a>
);
