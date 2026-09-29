# plugins/files delta —— webui-plugin-kernel

## ADDED Requirements

### Requirement: 文件夹共享插件（简单文件系统操作）

files 插件 SHALL 在提供侧（A 机）维护共享账本 `<DWEB_HOME>/plugins/files/shares.json`（id/name/root 绝对路径/mode ro|rw/授权 peers，默认 ro），并在 Fabric 会话端点 `/wpk1/files/<shareId>/<op>` 暴露操作：`GET list`/`GET stat`/`GET read`（offset/len 流式响应 + OID/etag 版本标识）/`PUT chunk`（分片上传 staging：uploadId/seq/offset/bytes，单 chunk ≤4MiB）/`POST commit`（总长+hash 校验后原子 rename）/`POST mkdir|rename|delete`。B 机 webui MUST 提供类型化文件浏览器页（浏览/面包屑/上传进度/下载/改名/删除；写操作按 share.mode 与授权显隐）。路径安全 MUST：root realpath 冻结 + 每操作解析后包含校验 + 禁 symlink 跟随（lstat 校验后打开、打开后 fstat 复核防检查-打开竞态）；staging MUST 用临时名 + TTL 回收，取消/断线/校验失败 MUST NOT 暴露半文件（未 commit 内容不出现在正式命名空间）。`<root>/.opendweb-ignore`（行 glob）MUST 生效且语义仅由提供侧定义。删除操作 UI MUST 显式确认。

#### Scenario: 浏览/下载/上传闭环（双机）

- **WHEN** iMac 共享目录（ro）授权 mini，mini 在 webui 浏览该目录、下载一个文件、随后 root 改 rw 后上传一个大文件（分片）
- **THEN** 浏览与下载内容一致（Range 续读可用）；上传在 commit 校验（总长+hash）通过后以单次原子 rename 落盘，中途可见的只有进度而非半文件

#### Scenario: 路径逃逸与 symlink 防护

- **WHEN** 请求 path 含 `..` 越界、绝对路径注入、或指向 root 内 symlink 的路径（symlink 指向 root 外）
- **THEN** 全部拒绝（明确错误），零字节越界读/写；symlink 不被跟随

#### Scenario: 断线中断与 staging 回收

- **WHEN** 分片上传中途会话断开且未再恢复，staging 目录留存
- **THEN** TTL 到期后被回收；正式目录中无对应半文件；同 uploadId 重试可幂等续传或整体重来（语义明确二选一并冻结）
