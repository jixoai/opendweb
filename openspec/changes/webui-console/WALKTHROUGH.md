# webui-console + sdk-mgmt-surface Owner 走查手册

> 前置：本 change 全部实现门绿（见 tasks.md）；云端 demo server 仍在跑
> （39.107.213.167:18787/13340，`DWEB_ADMIN_TOKEN=demo-admin-token`，
> restricted + static，registry 为走查 fabric 3f1de460…）。

## 一、一键故事（本地 WebUI 管理云端 server）

```bash
cd <worktree>
# 形态一（零安装直跑，推荐走查用）：
npm start --prefix packages/webui -- \
  --server http://39.107.213.167:18787 \
  --token demo-admin-token --allow-insecure
# 等价：node packages/webui/src/cli.mjs --server … --token … --allow-insecure
```

> 注意：走查目标是公网 **http**（非 https 非 loopback）→ 必须加
> `--allow-insecure` 才会启动（token 明文过公网的告警会在终端横幅 + UI
> 顶栏常驻——这是设计行为，demo 可接受；生产用 https 或隧道）。

```bash
npm start --prefix packages/webui -- \
  --server http://39.107.213.167:18787 \
  --token demo-admin-token --allow-insecure
# 终端打印 http://127.0.0.1:<port> 并自动打开浏览器（--no-open 关闭）
```

浏览器走查点（`#/status → #/owners → #/connections`）：

1. **status**：mode=restricted / policy=static / generation≥1 / owner 数=1；
   顶栏明文告警条常驻
2. **owners**：列表含走查 fabric；复制一条 owner 的 fabric_id/root 备用；
   注册一条测试二元组（随便 64 hex）→ 回执摘要出现（op=register/ts/
   generation/签名前 16）→ 注销它 → 回执 op=unregister
3. **connections**：空表（无 relay 在线连接）或 sap-verify 跑过则有计数；
   quota 显示 configured=false（demo 未设配额）
4. **断连**：无在线连接时点断连 → no-match 错误呈现（目标不存在提示）

## 二、setup 配对面（无 --server 启动）

```bash
npm start --prefix packages/webui -- --allow-insecure
# 终端打印 URL + 一次性配对码（13 字符）
```

浏览器 `#/connect`：粘贴 server URL + admin token + 终端里的配对码 →
提交 → 冻结成功跳 status；提交框清空不回显 token；再改目标 →
target-frozen（重指向需重启）。

## 三、CLI 插件面（需发布或本地链接后）

```bash
npm link --prefix packages/webui          # 本地链接（全局 bin opendweb-webui）
opendweb-webui --server http://127.0.0.1:18787   # bin 直跑（npx 同名，须先发布或 link）
opendweb webui --server http://127.0.0.1:18787   # CLI 单命令折叠直达（需 opendweb CLI）
opendweb webui --help                     # 零执行 help + token 可见性提示
# 注意：包未发布前 `npm exec -- opendweb-webui` 会静默退出（解析落空）——
# 本地走查一律用 npm start / node src/cli.mjs / npm link 后的 bin。
```

## 四、SDK 面（管理 SDK 消费者视角）

```bash
cd packages/client-sdk
node --input-type=module -e "
import { AdminClient } from '@jixo/opendweb-client-sdk/admin';
const c = new AdminClient({ baseUrl: 'http://39.107.213.167:18787', token: 'demo-admin-token' });
console.log(await c.status());
console.log(await c.probeEnabled());
"
```

回执验签/令牌解码示例见 `packages/client-sdk/README.md`。

## 五、预期边界（应拒绝的形态）

| 动作 | 预期 |
|---|---|
| 错 token 启动 + 访问 owners | UI unauthorized 横幅（提示重启换 token——目标冻结语义） |
| server 指到 `http://evil.example`（不加 allow-insecure） | 启动拒绝（非 loopback 明文） |
| 浏览器并发双配对 | 恰一成功一 409（单飞锁） |
| `/api/../status` 直打 sidecar | 404 且零上游出站 |

## 已知残余

- 本机同用户恶意进程不在威胁模型内（与 server.key 同层级）
- `--token`/env 途径 OS 级可见（help 有提示；推荐 TTY/配对面）
- demo 云端为 http——生产部署走 https 反代或 ext-cf 隧道
