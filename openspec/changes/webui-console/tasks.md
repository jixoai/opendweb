# Tasks: webui-console

> 依赖：sdk-mgmt-surface（./admin、./token、connections/disconnect 路由）。
> 顺序：Phase A（sidecar + Server 管理视图）→ Phase B（Owner 控制台）。

## Phase A — sidecar 与 Server 管理视图

- [ ] A.1 包骨架 `packages/webui/`（package.json：exports "."/"./opendweb-plugin"、
       bin、files 含 dist；tsconfig；Vite + Preact + htm 构建链）
- [ ] A.2 sidecar（node:http）：127.0.0.1 随机端口、静态 dist 托管 + SPA
       fallback + no-store、/api/* → /admin/* 白名单反代 + Bearer 注入 +
       hop-by-hop 剥除 + 10s 超时、日志脱敏（无 headers/token）
- [ ] A.3 token 获取链：--token > DWEB_ADMIN_TOKEN > TTY 交互（回显关闭；
       非 TTY 无来源报错）；POST /api/session 运行时更新（不回显）
- [ ] A.4 明文远端守卫：非 https 非 loopback 拒启（exit 2）/--allow-insecure
       放行 + 终端横幅 + UI 顶栏警示条
- [ ] A.5 plugin 清单（src/plugin.mjs：webui 命令 + args JSON Schema）+
       cli.mjs 入口（参数→token→sidecar→打印 URL/自动打开 --no-open）
- [ ] A.6 SPA：#/connect → #/status → #/owners → #/connections（轮询 5s、
       AdminError 呈现、回执展示、断连二次确认）
- [ ] A.7 sidecar 单测（node:test）：token 优先级、明文拒启/放行、/api
       白名单越界 404、日志无 token、静态 fallback、session 不回显
- [ ] A.8 plugin 契约测试：manifest 过 PluginManifestSchema、--help 零执行
- [ ] A.9 e2e：起真 restricted server → sidecar 连接 → /api/status 透传 →
       注册/断连全流程（fetch 驱动，不启浏览器）
- [ ] A.10 UI 构建 + dist 冒烟；绿门（node --test 全套 + 手动走查记录）

## Phase B — Owner 控制台

- [ ] B.1 --data-dir：lazy import client-sdk（optionalDependency；缺失
       try/catch 降级提示安装命令）
- [ ] B.2 fabric 打开/附加（root 全功能 / 成员只读 + 灰化矩阵）
- [ ] B.3 #/console 视图：成员名册、邀请签发表单（ttl/recipient）+ ./token
       解码摘要展示（recipient/过期/relays 与 capability 标注）、撤销二次
       确认、capability 到期视图（<7d 高亮）
- [ ] B.4 单测：optional 加载矩阵（装/未装）、root/成员功能矩阵、邀请摘要
       与 ./token 解码一致性
- [ ] B.5 e2e：本地 fabric 数据面全流程（签发→展示→撤销）；进程回收纪律
       （冒烟进程显式退出 + 端口清点）

## 收口

- [ ] C.1 README（快速开始：opendweb webui / npx；安全边界表；明文告警
       说明；本地威胁模型残余声明）
- [ ] C.2 Owner 走查包：WALKTHROUGH 增 webui 一节（本地连云端 demo 实操）
- [ ] C.3 绿门总收口 + openspec strict 校验
