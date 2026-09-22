# Tasks: webui-console

> r1 修订：Owner 控制台拆出至 webui-owner-console；本 change 单期交付
> sidecar + 配对面 + plugin 接线 + Server 管理视图。
> 依赖：sdk-mgmt-surface（./admin、./token、connections/disconnect 路由）。

## Phase A — sidecar 与 Server 管理视图

- [ ] A.1 包骨架 `packages/webui/`（package.json：exports "."/"./opendweb-plugin"、
       bin、files 含 dist；Vite + Preact + htm 构建链）
- [ ] A.2 `src/target.mjs` 目标守卫：绝对 http(s)、路径段 .. /编码斜杠拒绝、
       http→loopback 解析（含 localhost 全记录校验、IPv4-mapped、zone-id 拒、
       尾点剥除、默认端口序列化）、解析 IP 连接 + Host/SNI 固定、
       --allow-insecure 仅放宽加密判断、不跟重定向
- [ ] A.3 `src/sidecar.mjs`：127.0.0.1 随机端口；静态 dist + SPA fallback +
       no-store；/api/* → /admin/* 白名单反代（GET/POST/DELETE；Bearer 注入；
       10s 超时；**入站 raw path 解析函数 + 拼接后二次 /admin/ 断言 + 越界零
       出站**；stdlib http/https.request 按解析 IP + SNI + Host 逐请求连接；
       body 界 1MiB/64KiB + 响应头白名单；hop-by-hop 剥除；setup 态 503
       no-target）
- [ ] A.4 配对面 `/sidecar/connect`：一次性配对码（终端打印；常时比较；单次
       有效 10min；连败 5 次销毁）+ Host===127.0.0.1:port 校验 + Origin
       同源/缺失校验；成功即目标冻结（再提交 target-frozen）
- [ ] A.5 token 获取链：--token > DWEB_ADMIN_TOKEN > TTY 交互（回显关闭）；
       argv/env 途径横幅可见性提醒
- [ ] A.6 `src/plugin.mjs` 契约清单（run envelope {command,args,log,cwd,
       stdout,stderr} 实测形态）+ `src/cli.mjs`（URL/port 自担校验；打印
       URL/配对码；--no-open；浏览器打开失败仅打印；**token 不入 log/错误串**）
- [ ] A.7 SPA：#/connect 配对面 → #/status → #/owners → #/connections
       （轮询 5s、AdminError code 呈现、回执展示、断连二次确认 + 收敛两态；
       **apiFetch 可注入抽象层**）
- [ ] A.8 单测（node:test）：target 守卫矩阵、配对面防线矩阵（无码/错码/
       坏 Origin/坏 Host/连败销毁/冻结）、/api 入站路径矩阵（`/api/../`、
       `%2e%2e`、编码斜杠/反斜杠、重复斜杠 → 404 且假上游零出站）、setup
       503、日志无 token、hop-by-hop 剥除、body 界超限 abort
- [ ] A.9 plugin 契约测试：manifest 过 zod、--help 零执行 + **token 提示
       help golden fixture** + parser 矩阵（--token value/=value/boolean 形态）
- [ ] A.10 e2e：真 restricted server → --server 启动业务通 → setup 流程
       （带码 connect → 冻结 → 业务通）→ 注册/断连全流程（fetch 驱动；
       常驻进程显式回收）
- [ ] A.11 UI 构建 + dist 冒烟 + **apiFetch 失败态注入矩阵**（not-enabled/
       unauthorized/502/network/timeout/no-match 六路呈现断言）；绿门
       （node --test 全套）

## 收口

- [ ] C.1 README（快速开始 opendweb webui / npx；安全边界表；明文告警；
       argv/env 可见性；本地威胁模型残余声明）
- [ ] C.2 Owner 走查：本地连云端 demo 实操记录（验收证据）
- [ ] C.3 绿门总收口 + openspec strict 校验
