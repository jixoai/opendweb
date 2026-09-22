// 测试夹具插件（单命令 manifest）：单命令折叠派发用——命令 token 可省略
// （opendweb solo --server X ≡ opendweb solo solo --server X）。run 输出
// command/args 快照，让 e2e 能断言折叠确实派发了唯一命令且 argv 完整。
export default {
  name: "solo",
  apiVersion: 1,
  commands: [
    {
      name: "solo",
      description: "only command of a single-command manifest",
      args: {
        type: "object",
        properties: { server: { type: "string" }, loud: { type: "boolean" } },
        required: [],
      },
    },
  ],
  async run({ command, args, log }) {
    log(`solo run command=${command} server=${args.server ?? "-"} loud=${args.loud === true}`);
    return { exit: 0 };
  },
};
