// SPA 挂载入口（构建期经 Vite 打包；运行时纯静态产物）。
import { render } from "preact";
import { html } from "./html.mjs";
import { App } from "./app.mjs";
import "./styles.css";

render(html`<${App}/>`, document.getElementById("app"));
