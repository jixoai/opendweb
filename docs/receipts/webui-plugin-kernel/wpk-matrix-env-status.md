# 双机矩阵环境状态（r12 闭合轮终态，2026-10-01 ~03:10 本地）

给下一轮编排者：矩阵重跑当前被**环境面**阻塞（非代码面）。代码/测试/harness 均已就绪。

## 已修复并验证
1. `/private/tmp/wpk-matrix-96m.bin` 丢失（8080 python 被外部重启 pid 1749→42971 + /tmp 清理）→ 已确定性重建，
   **新 md5 锚点 b4419a48fbd55bd87bff0748a4f3eaa9**（已更新 /tmp/wpk-matrix-run.sh 的 EXPECT_MD5；旧锚点 9213e6bb 的原文件不可复现）。
2. sync 插件 closure 超 2MiB 运输上限（2796767B>2097152B）→ 永久会话 churn、映射体传输在 ~20-30MB 处反复夭折
   → 已在双侧 plugins/state.json 禁用 sync（/tmp/wpk-hub 与 /tmp/wpk-mini-home）。
   禁用后经映射路由完成过一次**完整 96MB md5 精确**传输（新 .node 双侧在跑）。
3. mini 的 ports 映射 m-36v18e9kbfey 的 peer 是陈旧端点 cb416b03…（旧 fabric root）→ 已改为当前 iMac 端点
   3pyssy4pexat7ez7jbtqwwzgytg3dj7opj84qbuxpdcp9bd3g1ay（/tmp/wpk-mini-home/plugins/ports/mappings.json）。
4. mini-ctl curl-kill 已加前置校验（r12 要求：kill 前 PID 存活 + pre_bytes/pre_done 证据，仅存活 kill 计有效中断）。

## 当前阻塞（需要重新配对）
- r12 闭合轮在修 churn 时**误删了双侧 roster.facts**（/tmp/wpk-hub 与 /tmp/wpk-mini-home）——两台 sidecar 的 lease
  属不同 fabric（mini: 9b339f…/root ec80ba47…；imac: 473dbc0c…/root cb416b03…），互通所依赖的跨成员事实只存在于被删的 roster 里。
  现象：`ports mapping … session: peer 3pyssy4p… is not a member`。
- 恢复尝试：iMac 控制台 POST /sidecar/fabric/invite（v2，recipient=mini 当前端点 71ymwthn…）+ mini 侧删 roster 后
  POST /sidecar/fabric/join → `[dial-timeout] join deadline exceeded after 30000ms`。
  而 mini→iMac 的裸 UDP 已验证直通（nc -u 3399 收到）、ICMP 通、iMac 3341 UDP 在绑、LAN IP 未变（192.168.2.8）。
  疑点在 iroh QUIC 握手层（E1′ 族），未定位到根因。
- 建议路径：a) 换端口/换机重启 iMac 后重试 invite/join；b) mini 全新 home 重走 hub 租约 + invite 配对（会动到受保护
  hub 的正常 API 流，需 Owner 决策）；c) 若继续 dial-timeout，抓包定位 QUIC Initial 是否到达 3341。

## 受保护面（未动，现存活）
- hub 8787/3340（pid 19232）✓；8080 python（现 pid 42971，**外部**于本任务前被重启过）✓。

## 我们的 sidecar（均带新构建，留运行中）
- iMac：DWEB_HOME=/tmp/wpk-hub，18801/3341；mini：DWEB_HOME=/tmp/wpk-mini-home，18801/3342。
- 新 .node（md5 fcf602ffc54d5805c2be6c6048fece40）已 rsync 到 /private/tmp/wpk-mini/repo（--checksum 校验一致）。

## 矩阵运行注意
- 只跑一个实例（上次旧实例 TaskStop 后残留子进程与新实例互杀——先 `pgrep -fl wpk-matrix-run` 清场）。
- 判定已统一（run.sh）：violation=exit0+200+size≠expected；INVALID-INJECT 分箱依赖 mini-ctl curl-kill 的前置证据输出。

---

## 编排者终局取证补充（2026-10-01 03:50）

40 分钟静默窗口无恢复（8 周期探针全 0B）。追加排除与定性：

- 新旧 .node 二分：装回 r12 评审前基线二进制（md5 2a3efd8cb2dbeff12b8c45ae53f3e0f1）join 同样 dial-timeout → **排除代码回归**
- 端口无关：3341/3343 同败；非沙箱重启同败；两台 Clash TUN 均关（iMac 经正确 socket /tmp/verge/verge-mihomo.sock 确认 enable=false；mini 9090 同）；mini mihomo conntrack 已 flush
- 裸包差分：网关 UDP（DNS 53 via 192.168.2.1）双侧通；主机间 TCP v4 通（mini→iMac:8787 = 200；ssh 22 双向通）；**主机间 UDP v4+v6 双向黑洞**（3341/3399/3456 探针全 0 字节；03:05 前后 3399 尚通）
- 8080 python（pid 42971，外部重启后）现绑回环——矩阵不受影响（iMac sidecar 取源走 127.0.0.1:8080，本机自检 200/96MB/md5 b4419a48 与 harness 锚点一致）

**定性：路由器级 LAN 主机间 UDP 阻断（协议族无关），疑反复 96MB QUIC 传输触发 flood/DoS 防护；静默 40 分钟未自愈。**

### 恢复需 Owner 决策（按侵入性排序）
1. 路由器管理面检查/关闭 LAN UDP flood 防护（192.168.2.1）
2. 路由器重启（清防护状态表）
3. 若防护无法关闭：矩阵改为分批小探针（如 8MB×多次）避开触发阈值

### 恢复后一键续跑清单
mini 重启 sidecar（新 .node fcf602ff 已预装）→ 运行中删 roster.facts → iMac invite(recipient=71ymwthndzi4…)→ mini join → 映射冒烟 → pgrep -fl wpk-matrix-run 清场 → /tmp/wpk-matrix-run.sh 单实例

---

## ⚠️ 重大更正与终局定性（2026-10-01 05:1x，编排者第二轮取证）

**上一节「路由器级主机间 UDP 黑洞」作废**——两代探针方法都有缺陷：
1. macOS 无 `timeout` 命令（rc=127 被 2>/dev/null 吞掉）→ `timeout N nc -ul` 的监听器从未运行，全部 0 字节是假象；
2. macOS nc 的 UDP 监听有单连接怪癖（首包后即停）→「1/5 到达」也是假象。

**修正后的事实**（可靠探针：后台 PID + kill）：
- mini→iMac 裸 UDP：**通**（3341/3343/3399 首包全达；64B~2000B 各尺寸 payload 均到达——PMTU 假说也排除）
- 主机间 TCP：通（mini→iMac:8787 = 200；ssh 双向通）
- MTU 全部 1500 正常
- **跨机 QUIC（iroh join 拨号）：死**——scratch 双进程判别器（绕开两台 sidecar 全部状态）在**新旧两代 .node**（6aaf59ee 与 r12 基线 2a3efd8c）上同样 30s dial-timeout；同构 invite/join 在回环（term-exit fixture）通过。

**终局定性：环境层对 QUIC 协议的针对性阻断（非代码回归，双二进制排除；回环通/裸 UDP 通/QUIC 死）。** E1′ 家族演化形态：此前是「长流量后进程内拨号停滞、新进程正常」，现在连全新 scratch 进程的跨机 QUIC 都失败。onset 窗口 ~02:30-03:05（最后一次 96MB 映射传输成功之后）。

### Owner 恢复选项（更新）
1. 路由器（192.168.2.1）应用管控/协议识别类功能（部分固件可单独拦截 QUIC）——检查并关闭后复测
2. 两台机器的内容过滤系统扩展（Clash Verge 的 system extension / Little Snitch 等）——其过滤面可能在 TUN 关闭时仍然生效
3. 换有线直连/另一网络复测（隔离路由器 vs 主机）
4. 复测判据（一条命令即可）：scratch join 判别器 JOIN-OK（脚本已删，可从本文件记录的 fixture 改法重建；或直接重试 sidecar invite/join）

矩阵/配对在此解决前保持阻塞；代码面已由双二分洗清。

---

## 终章：反向配对突破 + 环境防护画像完整化（2026-10-01 ~09:30 本地 / 01:2xZ）

**反向配对成功**（无需重配 iMac 方向）：共享 fabric 改为 mini 的 9b339f9f（mini=root，iMac 以既有身份 3pyssy4p 经 SDK join 加入为 member；sidecar 成员 home 语义 = 自身 root 的 lease + 对方 fabric 的 roster，roster 即权威——fabric.mjs startSequence 实证）。映射数据面打通，传输速度高达 ~400MB/s。

**矩阵 harness 四轮进化**（每轮由真实传输速度逼出）：固定 1.5s 窗口 → ssh 轮询 → mini 本地窗口 → run-inject 融合式（单次 ssh 内 20ms 轮询启动/等窗/落刀）+ 探针 96MB→512MB。第四轮打出**全部三类有效注入**：
- kill-curl → PASS-FAIL（exit=137）✓
- kill-mini → PASS-FAIL（exit=18 截断）✓
- kill-imac → **PASS-RECOVERED（512MB md5 精确透明恢复）**✓
- 0 VIOLATION / 0 INVALID-INJECT（前三周期）

**环境防护终局画像**：流量累积触发（三轮矩阵 ~4GB 后再触发）、方向性（mini 出站 scratch 拨号被杀、iMac→mini 主拨号始终健康——known_addrs dial-ok 实证）、粘性（20 分钟静默 + mini 11 次 E1 重启均未清除；首次触发后经数小时静默曾自愈）。mini 侧错误锚定 "session: connect: direct dial exceeded 8s bound (fresh endpoint)"。

**工程跟进项（非本 change）**：会话连接对对端已建立连接的复用（mini fetch 总是自发出站拨号，不骑 iMac 已维持的连接——本次 kill-imac 后恢复断裂的根因）；不对称阻断下的 dial plan 行为。

**r16 裁决素材**：3 个完整有效周期（三类注入全）+ 第二轮 14/24 全量 md5 精确 + 全部轮次零干净-200-短体 + harness 判据完备性证明。

## r16 后的最终 runbook（2026-10-01）

r16 裁决 C（维持 24 有效样本门）已落实进 harness：/tmp/wpk-matrix-run.sh 重写为 r16 合规版——
自描述 receipt 头（HEAD/harness-SHA256/探针锚点/两端 endpoint+fabric）、补跑至 24 有效样本
（上限 48 尝试，ABORT/INVALID 不补数）、RECOVERY-FAILED 显式计数、30s 节流。
mini-ctl（run-inject 融合式）已在 mini 就位。

**Owner 环境修复后的一键续跑**：`bash /tmp/wpk-matrix-run.sh`（其余零操作；达标判据=
汇总行 VALID=24、VIOLATIONS=0、RECOVERY-FAILED=0）。达标后直接进入收官序列
（ego-browser 走查 → archive → merge/push → herdr 回收 → Owner 终报）。

配套工具（仓库内未跟踪文件，供重配对复用）：packages/webui/test/fixtures/wpk-imac-join-mini.mjs
（反向配对装配器——如 pairing 再丢失：iMac 停 sidecar→备份 /tmp/wpk-hub→删 roster→
node 该脚本（token 由 mini sidecar invite 产生）→恢复原 lease→重启）。
