#!/usr/bin/env node
// 复审 6.2 集成回归夹具：慢速 preStop 本地插件。钩子被调用时先落 marker 再
// 延迟退出，让测试侧从文件时序观察 CLI 的单飞停止编排（server.stop 只在
// 唯一 preStop 流程完成后触发）。环境变量：
// - SLOW_PRESTOP_LOG：marker 日志文件路径（必填）
// - SLOW_PRESTOP_DELAY_MS：preStop-start 到 preStop-done 的延迟（默认 800）
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--opendweb-declare")) {
  process.stdout.write(JSON.stringify({ name: "slow-prestop", hooks: ["server.preStop"] }) + "\n");
  process.exit(0);
}
if (args.includes("--opendweb-hook")) {
  appendFileSync(process.env.SLOW_PRESTOP_LOG, "preStop-start\n");
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.SLOW_PRESTOP_DELAY_MS ?? 800)));
  appendFileSync(process.env.SLOW_PRESTOP_LOG, "preStop-done\n");
  process.exit(0);
}
