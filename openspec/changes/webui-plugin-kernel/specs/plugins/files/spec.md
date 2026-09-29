# plugins/files delta —— webui-plugin-kernel

## ADDED Requirements

### Requirement: 文件夹共享插件（简单文件系统操作）

files 插件 SHALL 在提供侧（A 机）维护共享账本 `<DWEB_HOME>/plugins/files/shares.json`（id/name/root 绝对路径/mode ro|rw/授权 peers，默认 ro），并在 Fabric 会话端点 `/wpk1/files/<shareId>/<op>` 暴露操作：`GET list`/`GET stat`/`GET read`（offset/len 流式响应 + OID/etag 版本标识）/`PUT chunk`（分片上传 staging：uploadId/seq/offset/bytes/**chunkHash**（客户端声明块摘要，服务端从 bytes 重算比对）；同幂等键（uploadId/seq/offset）同内容=幂等成功、不同内容=明确拒绝不覆盖；单 chunk ≤4MiB）/`POST commit`（按序核对全部分片总长+整文件 hash 后原子 rename）/`POST mkdir|rename|delete`。B 机 webui MUST 提供类型化文件浏览器页（浏览/面包屑/上传进度/下载/改名/删除；写操作按 share.mode 与授权显隐）。路径安全 MUST 为 fd 链逐组件遍历：share root 以目录 fd 冻结，每操作从 root fd 按路径组件逐级打开（目录组件带 O_DIRECTORY+O_NOFOLLOW 语义拒绝 symlink，最终组件按操作类型带 O_NOFOLLOW），逐级持有父目录 fd，最终操作只作用于已验证 fd（fstat 复核类型）——lstat+open 两步不构成合格实现；staging MUST 用临时名 + TTL 回收，取消/断线/校验失败 MUST NOT 暴露半文件（未 commit 内容不出现在正式命名空间）。`<root>/.opendweb-ignore`（行 glob）MUST 生效且语义仅由提供侧定义。删除操作 UI MUST 显式确认。

#### Scenario: 浏览/下载/上传闭环（双机）

- **WHEN** iMac 共享目录（ro）授权 mini，mini 在 webui 浏览该目录、下载一个文件、随后 root 改 rw 后上传一个大文件（分片）
- **THEN** 浏览与下载内容一致（Range 续读可用）；上传在 commit 校验（总长+hash）通过后以单次原子 rename 落盘，中途可见的只有进度而非半文件

#### Scenario: 路径逃逸与 symlink 防护（含父目录组件竞态，r2-B2）

- **WHEN** 请求 path 含 `..` 越界、绝对路径注入、或指向 root 内 symlink 的路径；**且攻击者循环地把共享根内的中间目录替换为指向 root 外的 symlink，同时并发发起读写请求**
- **THEN** 全部拒绝（明确错误），零字节越界读/写；symlink 不被跟随（fd 链逐组件遍历：每级目录组件拒绝 symlink，最终操作只作用于已验证 fd）——并发竞态下 root 外零读写副作用（以 root 外文件系统监测断言）

#### Scenario: 断线中断与幂等续传（r4-N5 扩充验收）

- **WHEN** 分片上传中途会话断开后以同 uploadId 重试（重复 PUT 同 seq/offset 分片且 chunkHash 相符）；或同幂等键但 bytes 内容不同（chunkHash 不符）；或伪造 chunkHash（与 bytes 重算不符）；或 commit 时整文件 hash 与分片拼接结果不符
- **THEN** 同键同内容=幂等成功（不重复落盘不报错）；同键异内容=明确拒绝不覆盖；伪造 chunkHash=拒绝；整文件摘要不符=整体拒绝且零落盘；合法路径在 commit 全片校验（总长+hash）后单次原子 rename；放弃的 uploadId staging 由 TTL 回收；正式目录永无半文件
