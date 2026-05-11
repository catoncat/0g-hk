// Page header — small logo + optional right-side slot (e.g. seg controls).
import type { FC } from "hono/jsx";
import { BASE_HOST } from "../constants.js";

export const Header: FC<{ right?: any }> = ({ right }) => (
  <header class="page-header">
    <a class="logo" href={"https://" + BASE_HOST + "/"}>0g<span class="dot">.</span>hk</a>
    {right}
  </header>
);
