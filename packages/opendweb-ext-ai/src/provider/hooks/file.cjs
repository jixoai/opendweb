// adapted from ai-fly hooks/file.cjs (v0.6.0)
// 内建 hooks 脚本：file —— JSON 文件取值（点径）。
// 阶段矩阵：
// - onRequestBearerAuthentication(ctx) -> string：① auth 阶段，读 args.path（支持 ~）
//   + args.jsonPath（.a.b 风格），返回裸值（"Bearer " 前缀由服务 auth 槽的 bearer
//   开关单源拼装——脚本不得自行加前缀）。
// （与上游分歧：ai-fly 另有 hooks/env.cjs——本包不存在该脚本，W11 凭证纪律。）
module.exports.onRequestBearerAuthentication = function onRequestBearerAuthentication({ homedir, args }) {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const path = args && args.path;
  const jsonPath = (args && args.jsonPath) || ".";
  if (typeof path !== "string" || path === "") throw new Error("file hook requires args.path");
  const abs = path.startsWith("~/") ? join(homedir, path.slice(1)) : path;
  let doc;
  try {
    doc = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    throw new Error("file unreadable or invalid JSON");
  }
  let cur = doc;
  for (const seg of jsonPath.split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) throw new Error("json path miss");
    cur = cur[seg];
  }
  if (typeof cur !== "string" || cur === "") throw new Error("json path value missing");
  return cur;
};
