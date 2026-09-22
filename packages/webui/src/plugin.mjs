// ./opendweb-plugin 清单导出（webui-console design §3——契约不扩展）。
// run envelope 为契约既定的 {command, args, log, cwd, stdout, stderr}；
// URL/port 等语义校验由 cli.mjs 自担。description 尾注承载 --token 的
// OS 可见性提示（ASCII）——help 渲染器原样呈现，golden fixture 钉住。

const TOKEN_NOTE =
  "[note: --token or DWEB_ADMIN_TOKEN is visible to other local processes (shell history, ps, env); prefer the hidden terminal prompt or the browser pairing flow]";

const manifest = {
  name: "webui",
  apiVersion: 1,
  commands: [
    {
      name: "webui",
      description: `local management console (sidecar + UI) ${TOKEN_NOTE}`,
      args: {
        type: "object",
        properties: {
          server: { type: "string" },
          token: { type: "string" },
          port: { type: "number" },
          "allow-insecure": { type: "boolean" },
          "no-open": { type: "boolean" },
        },
        required: [],
      },
    },
  ],
  run: async ({ command, args, log, cwd, stdout, stderr }) => {
    const { main } = await import("./cli.mjs");
    return main(args, { log, cwd, stdout, stderr });
  },
};

export default manifest;
