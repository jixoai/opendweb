# Tasks: sdk-mgmt-surface

## Phase 1 — Rust：admin API 扩面

- [ ] 1.1 抽取共享断连函数 `disconnect_online`（unregister 内联路径重构，
       admin.rs；unregister 行为零变化 + 既有测试全绿）
- [ ] 1.2 `GET /admin/connections`（online_view + 配额投影；open/None 如实
       空集；mode/policy 字段与 status 同源）
- [ ] 1.3 `POST /admin/connections/disconnect`（恰好其一校验 400 / 命中
       断开 + 回执 OP_DISCONNECT=0x03 / 未命中 404 带 `{"error":"no-match"}` /
       relay 未启用 200 空报告）
- [ ] 1.4 receipt_canonical 扩展 op 0x03（disconnect 载荷 = domain||op||ts||
       generation）+ 单测（canonical 冻结向量）
- [ ] 1.5 Rust 单测：disconnect 请求体矩阵（缺键/双键/坏 hex）、open 空投影、
       未命中 404 body、挂载语义回归（未设 token 全 404）
- [ ] 1.6 Rust e2e（server_access_e2e 追加）：restricted + 真实 relay 连接 →
       connections 计数 → disconnect → 视图收敛 + 回执 ServerIdentity 验签
- [ ] 1.7 绿门：`mbx test -p dweb-server --bins` + e2e 套件 + clippy/fmt

## Phase 2 — TS：./admin subpath

- [ ] 2.1 `packages/client-sdk/admin/`（AdminClient + AdminError + code 判别
       表 + receipt 结构化透出 + receiptCanonical + verifyReceipt 注入式 +
       adminPublicKeyFromServices）
- [ ] 2.2 package.json exports 增 `./admin`（types/default）+ d.ts
- [ ] 2.3 单测：mock fetch 全 code 路径（含 404 空 body vs no-match body
       判别）、超时、receiptCanonical 与 server 冻结对拍
- [ ] 2.4 无 native 环境导入冒烟（`node --input-type=module`，无 binding）

## Phase 3 — TS：./token subpath

- [ ] 3.1 `packages/client-sdk/token/`（decodeInvite/decodeCapability + 位图
       展开 + TokenError）
- [ ] 3.2 跨语言冻结向量：invite 向量 Rust 导出（沿用 CROSS_CRATE_CAP_VECTOR
       先例）+ cap 向量复用既有；package.json exports 增 `./token`
- [ ] 3.3 单测：冻结对拍 + 非法输入矩阵（前缀/长度/字符集/保留位）

## Phase 4 — 收口

- [ ] 4.1 TS e2e：AdminClient 打真实本地 server（npm script，与 Rust e2e
       同场景）
- [ ] 4.2 文档：client-sdk README subpath 说明（./admin ./token 用法 +
       token 安全注意）
- [ ] 4.3 绿门总收口 + openspec strict 校验
