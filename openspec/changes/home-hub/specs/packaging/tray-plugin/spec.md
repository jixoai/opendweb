## ADDED Requirements

### Requirement: 托盘插件包（opendweb tray，[H2]）

托盘 SHALL 以 opendweb 插件包交付（npm `opendweb-tray`，`./opendweb-plugin` 子路径导出，marketplace glob 自适应派发；**不进 builtin 集合**；可选——未安装不影响核心功能，中枢全生命周期 CLI 直达）。v1 交付形态=**无头控制器**（图标壳本体归 opentray 消费本契约，proposal 非 Goal）：

1. **进程内消费 webui SDK**（[H4]）：`opendweb tray` 经 createConsole 拉起本机控制台（`open(deepLink)` 为 tray open-console 的落点）；
2. **状态面**：`<DWEB_HOME>/tray-status.json` 心跳文件（≤1s 级 mtime 刷新，原子写）承载**版本化快照 schema v1**：`{v:1, state:"error"|"knock"|"running"|"unconfigured", knocks_pending:number, ts}`——优先级 异常>敲门角标 n>运行>未配置（PRODUCT-DESIGN §3.6 冻结表；「未配置」为 v1 可选呈现，纯成员机托盘不在 v1 承诺内——O-5）；数据源=hub.json/hub.pid+hub-token 调 /admin/status（3s 轮询）+console 事件；
3. **控制面（两种互斥模式，帧级冻结）**：默认模式=stdout **JSON-lines 事件流**（仅推送 webui SDK 同款 schema v1 事件，无请求语义）；`--ipc` 模式=stdin/stdout **JSON-RPC 2.0**（newline 分帧；request id 透传；错误 envelope `{code,message}`；**不支持 notification 与 batch**（收到即 `-32600` error 响应）；单帧上限 64KB——超限返回 error 帧（id 取帧前缀可解析值，否则 null）不断流；坏 JSON=error 帧继续服务；stdin EOF=优雅退出；stderr 仅归日志，事件与 RPC 不混流）。**golden 帧样例（契约测试冻结）**：

```jsonl
→ {"jsonrpc":"2.0","id":1,"method":"open-console","params":{"deepLink":"#/lease"}}
← {"jsonrpc":"2.0","id":1,"result":{"ok":true}}
→ {"jsonrpc":"2.0","id":2,"method":"set-autostart","params":{"on":true}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"hub not initialized"}}
→ {"jsonrpc":"2.0","method":"open-console"}
← {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"notifications not supported"}}
← （注：所有 error 帧同成功帧一样 MUST 携带 "jsonrpc":"2.0" 字段——严格 JSON-RPC 2.0 validator 逐帧校验；错误帧 id 提取=语法解析前的受限前缀扫描）
→ [超长帧 >64KB]
← {"jsonrpc":"2.0","id":<前缀可解析则透传，否则 null>,"error":{"code":-32601,"message":"frame too large"}}
→ {坏 JSON}
← {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}
```

   方法集：`open-console`（参数 deepLink?）/`start`/`stop`/`set-autostart`——落点到 hub 命令与 createConsole；**hub-token MUST NOT 经 IPC/事件/心跳任何面暴露**（方法内部使用）。
4. **失联可察**：tray 进程退出（含崩溃）后心跳文件停止刷新，壳侧以 mtime 龄期判定失联。

插件包 v1 零外部依赖（无头形态）；README SHALL 冻结壳侧（opentray）对接契约：状态优先级表、菜单结构（PM §3.6 逐字）、深链落点、心跳失联判定、IPC 帧格式与示例（golden frames）。

#### Scenario: 无头运行与状态聚合

- **WHEN** 中枢运行且有 1 台设备待敲门时启动 `opendweb tray`
- **THEN** tray-status.json 快照 `{v:1,state:"knock",knocks_pending:1,...}`（优先级高于运行态）；stdout 事件流正常推送；进程退出后心跳 mtime 不再前进

#### Scenario: IPC golden 帧与异常帧

- **WHEN** 经 `--ipc` 依次发送合法请求（open-console 带/不带 deepLink）、notification（无 id）、batch 数组、超长帧（>64KB）、坏 JSON、随后正常请求，最后关闭 stdin
- **THEN** 合法请求返回带透传 id 的结果帧；notification 与 batch 各返回 `-32600` error 帧；超长/坏帧各返回 error 帧（id 按可解析前缀恢复或 null）且连接不断；随后的正常请求仍成功；stdin EOF 后进程优雅退出

#### Scenario: token 不出控制面

- **WHEN** 审查 tray 全部输出面（stdout 事件流/IPC 响应/心跳文件/stderr）
- **THEN** 不含 hub-token 或任何凭证材料

#### Scenario: 可选性

- **WHEN** 未安装 opendweb-tray 插件
- **THEN** `opendweb hub` 全命令族行为完全不变（核心不依赖插件）
