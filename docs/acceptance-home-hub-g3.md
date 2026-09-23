# acceptance：home-hub G-3 relay-only 对照（docker 双 bridge 隔离 UDP）

- 变更：`openspec/changes/home-hub`（design §7「G-3 技术对拍」/ spec「G-3 停机
  行为的 delta 验收（test-only）」）
- 性质：**非单测的 acceptance 记录**（一次性真实执行 + 自动断言），与
  `crates/dweb-fabric/tests/g3_hub_outage.rs` 的 `g3_relay_only_control_driver`
  （env 驱动 `#[ignore]` 用例）配套。
- 日期：2026-09-23（宿主侧执行一次）

## 1. 环境

| 项 | 值 |
| --- | --- |
| 宿主 | macOS（darwin 25.5.0 arm64，Apple Silicon） |
| Docker | Docker Desktop 29.7.2（daemon 经 `open -a Docker` 拉起，10s 内就绪） |
| 构建镜像 | `rust:1-bookworm`（linux arm64 容器原生执行） |
| 代码基线 | worktree `opendweb-sdk-mgmt-surface` HEAD `140c334`（本变更的工作树，
  含 `tests/g3_hub_outage.rs` driver） |
| 测试二进制 | `g3_hub_outage-ec1722fbb1002a50`（容器内
  `cargo build -p dweb-fabric --test g3_hub_outage --locked -j 2` 产物） |

## 2. 镜像与网络拓扑

两个 `--internal` bridge（容器无外网路由，跨 bridge 互不可达）：

```
g3neta 172.28.201.0/24 (--internal)     g3netb 172.28.202.0/24 (--internal)
  g3root   .201.20 ──┐                    ┌── .202.20 g3member
                     │   （跨 bridge 阻断）│
              g3relay .201.10 ════════════ .202.10（双归属容器）
              plain-http relay :3340（0.0.0.0）
```

- 中枢 relay 以**独立容器进程**承载（`G3_ROLE=relay`，iroh-relay plain http
  绑 `0.0.0.0:3340`）——`docker stop`＝**停整个中枢进程**（SIGTERM 进程死亡，
  OS 切断全部套接字）；`docker start`＝同容器同命令重启。plain http 无 TLS
  身份，重启无需保身份。
- 节点容器各跑 driver（`G3_ROLE=root` / `member`，Custom relay 指向 relay
  容器在本 bridge 侧的 IP）。`advertise_addrs` 为空；iroh 打洞交换的候选地址
  跨 bridge 不可路由 → 直连路径无法建立。
- 隔离探针（编排侧阳性/阴性对照，root 容器内执行）：
  `SAME_BRIDGE=REACHABLE`、`CROSS_BRIDGE=BLOCKED`。
- driver 侧隔离硬断言：member 全程 `link_status`/`PathChanged` 不得出现
  `Direct`（出现即 `ISOLATION_FAILED` 退出非零）。注：纯 relay 会话的
  path watcher 稳态实测为 `Unknown`（`Selected` 事件只在路径**跳变**时发出），
  故 relay-only 的判据是网络探针 + 行为证据（见 §6），不是 `Relay` 快照枚举。

## 3. 命令清单（宿主侧编排，等价脚本）

```sh
docker network create --internal --subnet 172.28.201.0/24 g3neta
docker network create --internal --subnet 172.28.202.0/24 g3netb
# 构建测试二进制（仓库 ro 挂载，target/cargo/rustup 走 named volume）
docker run --rm -v $REPO:/src:ro -v g3target:/target \
  -v g3cargo:/usr/local/cargo -v g3rustup:/usr/local/rustup \
  -e CARGO_TARGET_DIR=/target -w /src rust:1-bookworm \
  cargo build -p dweb-fabric --test g3_hub_outage --locked -j 2
BIN=/target/debug/deps/g3_hub_outage-ec1722fbb1002a50
ARGS="--ignored --exact g3_relay_only_control_driver --nocapture"
docker run -d --name g3relay --network g3neta --ip 172.28.201.10 \
  -v g3target:/target:ro -e G3_ROLE=relay -e G3_PORT=3340 -e G3_DURATION_SECS=540 \
  rust:1-bookworm $BIN $ARGS
docker network connect --ip 172.28.202.10 g3netb g3relay
docker run -d --name g3root --network g3neta --ip 172.28.201.20 \
  -v g3target:/target:ro -e G3_ROLE=root \
  -e G3_RELAY_URL=http://172.28.201.10:3340 -e G3_DURATION_SECS=480 \
  rust:1-bookworm $BIN $ARGS
docker run -d --name g3member --network g3netb --ip 172.28.202.20 \
  -v g3target:/target:ro -e G3_ROLE=member \
  -e G3_RELAY_URL=http://172.28.202.10:3340 -e G3_TOKEN=<root 日志 ROOT_TOKEN> \
  -e G3_ROOT_ID=<root 日志 ROOT_ENDPOINT> -e G3_DURATION_SECS=420 \
  rust:1-bookworm $BIN $ARGS
# 见 MEMBER_RELAY_ONLY_CONFIRMED 后：
docker stop  g3relay   # 停整个中枢进程（t_stop）
docker start g3relay   # 中枢回来（t_start）
docker inspect -f '{{.State.ExitCode}}' g3member   # 0 = 自动断言全过
```

## 4. 时间窗口（unix ms，docker 日志时戳）

| 事件 | t (ms) | 相对 |
| --- | --- | --- |
| `RELAY_READY`（中枢起） | 1790194507249 | — |
| `ROOT_PEER_CONNECTED`（会话建立） | 1790194516065 | 中枢起 +8.8s |
| `MEMBER_RELAY_ONLY_CONFIRMED` | 1790194516007 | 非直连稳态 |
| **`docker stop g3relay`（中枢全停）** | **1790194522185** | — |
| `MEMBER_SESSION_DROPPED` | 1790194555832 | **停机后 +33.6s 断开** |
| `ROOT_PEER_DROPPED`（root 侧对称） | 1790194555870 | +33.7s |
| **`docker start g3relay`（中枢回）** | **1790194601816** | 停机窗口 79.6s |
| `RELAY_READY`（重启完成） | 1790194602096 | start 后 0.3s |
| `MEMBER_SESSION_RECOVERED` | 1790194622781 | **中枢回后 +21.0s 自动恢复** |
| `ROOT_PEER_CONNECTED`（root 侧对称） | 1790194622896 | +21.1s |
| `MEMBER_DONE`（自终止，420s 时限） | 1790194936544 | — |

停机窗口内 member 心跳 send 无一次失败上报（断开检测前连接缓冲在途）；
恢复后双向心跳立即恢复在途。

## 5. 原始日志摘要

```text
SAME_BRIDGE=REACHABLE
CROSS_BRIDGE=BLOCKED
token_len=270 root_id=f7bjoardy3gg4us4...
=== member ===  MEMBER_RELAY_ONLY_CONFIRMED t=1790194516007
                MEMBER_SESSION_DROPPED     t=1790194555832
                MEMBER_SESSION_RECOVERED    t=1790194622781
                MEMBER_DONE t=1790194936544 elapsed=423.67s
                dropped_at=Some(1790194555832) recovered_at=Some(1790194622781)
                send_ok=699 send_fail=0        → member_exit=0
=== root ===    ROOT_PEER_CONNECTED t=1790194516065
                ROOT_PEER_DROPPED    t=1790194555870
                ROOT_PEER_CONNECTED  t=1790194622896
=== relay ===   RELAY_READY t=1790194507249 / RELAY_READY t=1790194602096
```

## 6. 结论

**EXECUTED ＋ 自动断言通过**（driver 进程退出码 0：掉线与自动恢复均发生、
全程无 Direct）：

1. **relay-only 会话在中枢进程全停后断开**：`docker stop`（真实进程死亡）后
   **33.6s** 两侧观察到会话断开（root/member 对称）——落在设计 §7「数十秒内
   断开」口径内。
2. **中枢回来后自动恢复**：relay 容器重启后 **21.0s** 会话经重连 worker 自动
   重建（无进程重启、无人工干预），心跳恢复在途。
3. **隔离有效性**：跨 bridge TCP 探针阻断 + driver 全程无 Direct——对照的
   「relay-only」前提成立；与主用例（300s 全停下 Direct 会话零中断，
   `hub_outage_direct_session_survives_300s`）构成行为不对称的互证。
4. PM 侧恢复时限文案**维持「依网络环境」口径**（本记录数字为单环境实测，
   不升级为产品承诺——设计 §7 降级条款的既定要求）。
