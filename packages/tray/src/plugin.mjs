// ./opendweb-plugin 清单导出（home-hub Phase 3a / specs/packaging/tray-plugin
// 「托盘插件包」）。契约不扩展：run envelope 为既定 {command, args, log, cwd,
// stdout, stderr}；单命令 manifest（name: tray）——`opendweb tray [--ipc]` 经
// foldSingleCommand 直达。运行时懒加载（--help 零执行路径不 import 控制器
// 链——无头控制器依赖 opendweb-webui SDK，装配代价只发生在真正运行时）。
// v1 无头形态说明承载在 description（ASCII——help 渲染器原样呈现）：open 不
// spawn 浏览器、opened 通知透出 console URL，壳侧（opentray）自行开窗。

const HEADLESS_NOTE =
  "[note: headless v1 - never spawns a browser; open-console emits an 'opened' notification carrying the console URL for the shell host to open]";

const manifest = {
  name: "tray",
  apiVersion: 1,
  commands: [
    {
      name: "tray",
      description: `headless hub tray controller: tray-status.json heartbeat + stdout event stream (default) or --ipc JSON-RPC 2.0 for the tray shell host ${HEADLESS_NOTE}`,
      args: {
        type: "object",
        properties: {
          ipc: { type: "boolean" },
        },
        required: [],
      },
    },
  ],
  run: async ({ args, stdout, stderr }) => {
    const { runTray } = await import("./controller.mjs");
    return await runTray({ ipc: args.ipc === true }, { stdout, stderr });
  },
};

export default manifest;
