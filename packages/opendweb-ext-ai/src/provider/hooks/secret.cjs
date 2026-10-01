// adapted from ai-fly hooks/secret.cjs (v0.6.0)
// 内建 hooks 脚本：secret —— 密钥库（SecretsStore）桥。
// 阶段矩阵：
// - onRequestBearerAuthentication(ctx) -> string：① auth 阶段，读 args.name 指定的
//   密钥（ctx.secrets 访问器；值只进头不回显——$secret 法则不变）。
module.exports.onRequestBearerAuthentication = function onRequestBearerAuthentication({ args, secrets }) {
  const name = args && args.name;
  if (typeof name !== "string" || name === "") throw new Error("secret hook requires args.name");
  const value = secrets && secrets(name);
  if (value === undefined || value === "") throw new Error(`secret '${name}' not found`);
  return value;
};
