# opendweb-webui

opendweb 本地管理控制台：浏览器 SPA（预构建静态资源）+ 本地 sidecar
（`node:http`，零运行时依赖）。sidecar 以同源 `/api/*` 反向代理远端
dweb-server 的 `/admin/*` 管理面并注入 Bearer token——**admin token 只驻
sidecar 进程内存**，不落盘、不进浏览器、不进日志。

```
浏览器（SPA，hash 路由）
   │  同源 http://127.0.0.1:<port>
   │  /api/*     业务代理（无凭证；目标冻结后才有意义）
   │  /sidecar/* 本地控制面（配对面；与 /api 物理分离）
   ▼
sidecar ── Bearer 注入 + 白名单反代 ──► 远端 dweb-server /admin/*
```

## 快速开始

两种形态同入口：

```sh
# 1) 经 opendweb CLI（marketplace 自愈安装，零预装）
opendweb webui --server https://srv.example:18787

# 2) 独立运行（npx / bin）
npx opendweb-webui --server https://srv.example:18787
```

token 获取链：`--token` > 环境变量 `DWEB_ADMIN_TOKEN` > 终端隐藏输入。
推荐终端隐藏输入或浏览器配对面（见下「argv/env 可见性」）。

### setup 模式（缺省 `--server`）

不传 `--server` 启动即进入 setup 模式：sidecar 打印访问 URL 与**一次性
配对码**（仅终端可见，10 分钟有效，连续 5 次失败销毁）。在浏览器配对面
填入配对码 + 服务器 URL + admin token 提交，成功后目标**冻结**（本
sidecar 生命周期内不可更改；重新指向 = 重启）。

配对面三重防线：一次性配对码（防外站提交）+ Host 头校验（防 DNS
rebinding）+ Origin 校验（防 CSRF）。

### 管理视图

- **状态**：mode / policy / generation / owner 数 / 在线投影（5s 轮询，
  页面隐藏时暂停）
- **Owners**：列表 / 注册（fabric_id + root，64 hex 客户端校验）/ 注销
  （二次确认 + 变更回执）
- **在线连接**：per-endpoint / per-owner 投影 + 配额在用/上限；主动断连
  （二次确认 →「已下发 / 收敛中」两态 + 有界轮询观测收敛 + per-target 回执）

变更回执：op / ts / generation / 签名前 16 hex 摘要 + 复制全文（回执为
Ed25519 签名的审计辅助，验签公钥见 server 的 services.json `server_id`）。

## 安全边界

| 边界 | 机制 |
|---|---|
| token 泄露面 | 只驻 sidecar 内存；不落盘 / 不进浏览器 / 不进日志；配对面提交后输入框清空且不回显 |
| 外站提交 / CSRF | 一次性配对码（仅终端可见，单次有效，连败 5 次销毁）+ Host 校验 + Origin 校验 |
| 目标劫持 | 目标生命周期内冻结；无运行时改目标路径；重指向 = 重启 |
| 明文公网 | `http` 非 loopback 默认拒启；`--allow-insecure` 仅放宽传输加密判断（终端 + UI 双重持续告警），不放宽目标/路径校验 |
| sidecar 滥用 | 仅绑定 `127.0.0.1`；`/api/*` 仅 `/admin/` 前缀 GET/POST/DELETE；不跟随重定向；不读环境代理变量 |
| argv/env 可见性 | `--token` 与 `DWEB_ADMIN_TOKEN` 有 OS 级可见性（shell history / ps / 环境读取），help 与启动横幅均有披露；推荐终端隐藏输入或浏览器配对面 |
| UI 越权 | 不提供自注册 / 数据面凭证操作；变更一律二次确认 + 回执 |

**已知接受残余**（与 server.key / 数据面同威胁层级）：本机同用户恶意进程
仍可读 sidecar 内存或注入；配对码防线的成立依赖终端与浏览器不同时被攻击
者控制。

## 开发

```sh
pnpm install            # 安装构建期依赖（vite / preact / htm —— 均为 devDependencies）
pnpm test               # node:test 全套（sidecar/CLI/契约/UI 失败态矩阵/dist 冒烟）
pnpm run build          # ui/ → dist/（构建产物提交入库：dist 随 npm 包分发）
```

包结构：`src/` 运行时（零依赖 sidecar + CLI + plugin 清单）；`ui/` 构建期
SPA 源码（Preact + htm + 手写 CSS，不发布）；`dist/` 预构建静态资源
（发布产物，入库）。
