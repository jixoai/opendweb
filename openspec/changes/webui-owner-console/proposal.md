# Proposal: webui-owner-console

> 登记来源：webui-console r1 评审（codex-review-sdkmgmt-r1 P1-8）——Owner
> 控制台（本地 fabric 数据面管理）原为 webui-console Phase B，因缺 sidecar
> wire 契约/身份 fixture/时间控制的可测性基础，拆出独立 change。
> 本 change 仅为登记，未排期、未设计。

## Why

Owner（fabric root/成员）需要一个图形面管理自己的数据面：成员名册、邀请
签发（含 `./token` 解码展示：发给谁/何时过期/带哪条 relay）、成员撤销、
relay capability 到期视图与续发入口。N-API 操作面已齐（invite/join/
members/revoke/ensure_relay_capabilities/export_secret_passphrase，
packages/client-sdk/src/fabric.rs:573-672），缺的是 sidecar 本地 JSON 契约、
身份 fixture（root/成员/损坏 roster/缺失 native）与可注入时钟（<7d 高亮
可测）——这些必须在设计期冻结，不得与 webui-console Phase A 混做。

## What Changes（登记草案，设计期细化）

- `opendweb-webui` 增 `--data-dir`：sidecar lazy import native binding
  （optionalDependency；缺失降级提示）。
- sidecar 本地数据面 JSON API（`/sidecar/fabric/*`，与代理面/配对面分离）
  + root/成员功能矩阵（成员侧操作灰化）。
- SPA `#/console` 视图族 + fake clock 测试。

## 依赖

- webui-console（sidecar/配对面/SPA 骨架）
- sdk-mgmt-surface（./token 解码）
