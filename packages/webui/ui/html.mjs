// 共享 htm 绑定（webui-console design §1：Preact + htm，无 JSX/无组件库）。
import { h } from "preact";
import htm from "htm";

/** 标签模板 → preact vnode（唯一渲染入口；视图/应用共用）。 */
export const html = htm.bind(h);
