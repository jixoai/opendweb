# Tasks: webui-plugin-kernel

> 设计基线 v2.3（r6 GO 9/10）。纪律：每 Phase 绿门=对应包 node --test 全绿 +
> 既有 webui 套件零回归 + openspec validate --strict + git diff --check；
> 显式路径 git add（禁 -A/禁 amend during parallel）；测试 fixture 一律临时目录；
> 子进程显式回收留证。
>
> 状态同步（2026-09-29，r9-B1 闭合时点）：实现/验收任务按提交与回执勾销
> （回执=真双机验收第五–八批实录 docs/acceptance-webui-plugin-kernel-dualmachine.md
> + §9.1 两轮十缺陷闭环 3370ca7 + 评审轮 r7 0206ade / r8 eec887b / r9 a4b264c）；
> 收官门与 [W7]-[W11] Owner 追认保留未勾（W11 安全默认），[W12] 已裁决落地
> （Codex approve）标注闭合。

## 1. Phase 0 —— 插件宿主（地基，其余 Phase 的前置）

- [x] WebUI 插件契约：`./opendweb-webui-plugin` export（webuiApi 1：id/pages/
      routes/dataEndpoints/configSchema）+ 类型面；CLI `./opendweb-plugin`
      apiVersion 1 契约零变化（既有测试零回归证明）
      ——契约权威源=packages/webui/src/core/plugins/contract.mjs（零依赖校验器，
      包根 export 面 + index.d.ts 类型面）；第一个真实导出该子路径的包在 Phase 1
- [x] 宿主运行时：进程内注册表（编译期静态注册内置三插件）、生命周期状态机
      （registered→enabled、enabled⇄disabled 两条有向转换）、停用顺序
      （先拒新→drain 默认 10s 可配超时强制取消+稳定错误→dispose→落盘）
      ——core/plugins/{registry,host}.mjs；runtimes 钩子通道（onEnable/onDispose）
      ——回执：d9c6329（Phase 0 落地）；P1 disable→enable 可往返修复 ad86588
      +走查闭环 12e2ab6（r9 确认通过）
- [x] 双账本：`<DWEB_HOME>/plugins/state.json`（0600 原子写+锁家族）+
      `<DWEB_HOME>/plugins/<id>/` 数据目录；安装账本 plugins.json 零接触
      ——core/plugins/state.mjs（leases.mjs acquireFileLock/atomicWrite0600 复用）
- [x] 控制面路由：`/sidecar/plugins`（GET 注册表+状态）、
      `/sidecar/plugins/<id>/enable|disable`（POST 精确 Origin）、
      `/sidecar/plugins/<id>/config`（GET/PUT）；Host 守卫沿用；零凭证
      ——sidecar.mjs 3e 段（admin/member 姿态均服务——设备本地运行时）
- [x] UI 接入：编译期 route registry（`#/p/<pluginId>/<pageId>`）+ routeFor
      扩展 + App.svelte 分派（命中且 enabled 渲染；disabled/未知按既有基线
      收敛）+ SideNav「工具」区（视角可见性过滤）+ 插件面板页（启停/配置/
      「即将推出」占位 vpn·clash·ai·ssh·screen + 「外部 WebUI 插件=后续」
      标注；marketplace CLI 候选不呈现为可启用）
      ——ui/src/lib/plugin-registry.ts（路由形状权威源+渲染裁决）+ plugin-pages.ts
      （组件绑定）+ 插件面板 #/p/host/panel（both 可见；member 深链直达）
      ——回执：真浏览器走查 7050b51（面板/路由/暗色/错误态主体 PASS）
- [x] 测试：生命周期 drain/摘牌、控制面四类 Origin 矩阵、路由接入四场景
      （可达/深链刷新/停用收敛/未知收敛+既有路由零变化）、双账本分离、
      既有 webui 全套零回归
      ——test/plugins-{host,sidecar,route}.test.mjs（30 用例；全套 225/225，
      基线 195 零回归）
- [x] dist 重建入库

## 2. Phase 1 —— ports 端口共享插件

- [x] 包 `@jixo/opendweb-ext-ports`（workspace；`./opendweb-webui-plugin`
      descriptor + 运行时）；webui 静态注册
      ——回执：741bdde（Phase 1 落地）+31ec160（收官接线统一装配）
- [x] 消费侧：映射账本 mappings.json（0600+锁）、本机 listener（仅 127.0.0.1，
      端口冲突明确报错）、逐请求 fetchHttp 代理（hop-by-hop 剥除清单+敏感头
      重写）、两阶段取消（头前 request.signal/头后 resp.abort→RESET→provider
      signal+上游 socket 收敛）、SSE 流式透传
      ——回执：741bdde；真双机第五批 ports SSE+中途断开收敛 PASS
      （d8d0f9a）
- [x] 提供侧：allowlist.json（(peer,remotePort) 默认 deny）+ `/wpk1/ports/
      proxy/<remotePort>` 端点（sessionId 隔离键+peer 授权）
      ——回执：741bdde；z32 会话 peer 与 hex64 账本同钥授权归一 2b13084
      （真双机 F1，同步侧同款 94806e2 回归网）
- [x] 限额：默认 1MiB 配置域 64KiB–1MiB/64KiB 粒度（r8-B4 包络收窄；超范围配置拒绝启动映射）、未知
      Content-Length 边读边累计拒绝、并发 ≤16+在飞预算 429
      ——回执：r8-B4/F2 v1 有效包络冻结落地 5a09aa1（Codex r8 裁定逐条实装；
      分层 transport double 三层账+边界 413/429 场景）；r9 确认通过
- [x] UI：映射管理页（列表/新增/启停/删除）
      ——回执：741bdde + 走查 7050b51
- [x] 测试：六 Scenario 全落（双机两阶段取消/已知超限 413/未知长度断开/
      并发 429+硬域/授权 deny/SSE+端口冲突）+ 单元面
      ——回执：741bdde + 3370ca7（§9.1 两轮十缺陷闭环+ports 等价性里程碑）
      +d8d0f9a（第五批）
- [x] 双机验收：mini curl localhost:9090 ≡ iMac 8080（含 SSE+中途断开收敛）
      ——回执：第五批 d8d0f9a PASS + 3370ca7 ports 等价性里程碑（r9 引证通过）

## 3. Phase 2 —— files 文件夹共享插件

- [x] 包 `@jixo/opendweb-ext-files`；共享账本 shares.json（默认 ro）
      ——回执：075b4b1（Phase 2 落地）+31ec160（接线）
- [x] 路径安全：root 目录 fd 冻结+逐组件 fd 链遍历（目录 O_DIRECTORY+
      O_NOFOLLOW 拒 symlink；macOS /dev/fd 组合；win32 等效为实现义务）
      +最终 fstat 复核；并发逃逸验收测试（攻击者循环替换 vs 并发请求，
      root 外零副作用）
      ——回执：075b4b1（src/fdchain.mjs：fd-chain 能力探测——linux /proc/self/fd；
      darwin /dev/fd 实证不可用→显式 verified-walk 降级：冻结 root fd+逐级
      O_DIRECTORY|O_NOFOLLOW+身份复核+运行时互斥；win32 显式拒绝不静默弱化）
- [x] wire：list/stat/read（offset/len+OID etag）/PUT chunk（chunkHash 字段，
      服务端重算；同键同内容幂等/异内容拒/伪造拒）/commit（全片总长+整文件
      hash 校验后单次原子 rename）/mkdir/rename/delete（UI 确认）
- [x] staging：uploadId 目录化+TTL 回收；.opendweb-ignore
- [x] UI：文件浏览器页（浏览/面包屑/上传进度/下载/改名/删除；写按 mode+授权
      显隐）
      ——回执：075b4b1 + 走查 7050b51；files 恰 1MiB/超 1B 边界+disable→enable
      往返修复 ad86588（第八批 5a09aa1 链）
- [x] 测试：全部 files Scenario（浏览下载上传闭环/逃逸+竞态/断线续传+伪造+
      整文件摘要不符）+ 单元面
      ——回执：075b4b1；r9 本轮独立复跑 ext-files lifecycle 47/47 全绿
- [x] 双机验收：mini 浏览/下载/上传 iMac 共享目录；中断不留半文件
      ——回执：第五批 files 全链路 PASS（d8d0f9a）+第八批恰 1MiB/超 1B 边界
      （5a09aa1）

## 4. Phase 3 —— sync 文件同步插件

- [x] 包 `@jixo/opendweb-ext-sync`；isomorphic-git+node-diff3 依赖入包
      ——回执：c6cd13a（Phase 3 落地）+31ec160（接线）
- [x] 组账本 groups.json+gitdir 布局（插件目录内）；多成员 ref 命名
      （refs/devices/<endpointId>/main+组收敛 ref）；[W9] seed authority UI
      （非空对端阻断+三方对照）
      ——回执：c6cd13a；建组显式 id 透传 94806e2；Scenario 12 真双机第六批复放
- [x] 对象端点：GET refs/POST want/GET object/POST push；闭包校验（parent/
      tree/blob 全闭包，缺项拒绝+清单，ref 零变化）；超限 >1MiB（r8-B4 包络）commitLocal 预检 oversize-history 不写史+整 push
      原子拒绝
      ——回执：c6cd13a + push 取消线性化/组级并发预算/真实持久 staging 816116d
      （r7-B3）+ 1MiB 包络/closure 流账 5a09aa1（恰 1MiB 通过/超 1B 拒）
- [x] ref CAS（expectedOldRef；不匹配拒绝提示重 fetch）+每 repo 单写者
- [x] 自持三方树合并：分类 add/modify/delete/type/mode；文本 diff3
      （stringSeparator \n）；冲突分级 hunk（a/b/o 逐块选/编辑）vs 文件级
      （binary/超限/非 UTF-8/delete-modify/type/mode——保守规则：mode 变化与
      对端内容变化一律文件级）；ours/theirs endpointId 稳定排序；冲突记录
      持久化（base/ours/theirs OID+算法版本+决议）；merge driver 钩子位
- [x] intent 事务协议：prepare（txId/target/路径操作清单含 preimage+postimage
      元组 OID·type·mode）→幂等物化（临时文件+fsync+rename）→CAS→done；
      恢复=ref 三态分诊（==targetCommit 逐路径只接受 postimage 否则不补 done
      保留 intent conflicted；==oldRef 路径三态分诊+物化+CAS；其他冲突停止）
      +路径三态（preimage 应用/postimage 已完成/其他=用户新改动保留转冲突）
      ——回执：c6cd13a（四边界崩溃注入测试）+真双机双向恢复语义复放（第七批
      8de7e8a 矩阵 #2#3#4#9 4/4）
- [x] 调度：会话在线事件+30s 兜底+本地 debounce 2s；预算（1MiB/5000 对象/
      256MiB/2 流；closure wire ≤2MiB 流账预检）；任务状态机+UI 状态页
      ——回执：c6cd13a + F5 intervalMs/debounceMs 配置接线+staging 空壳即时
      回收 39fd8e4 + closure 流账预检 5a09aa1
- [x] UI：同步组管理/状态/冲突决议页（hunk 并排+选块+文件级选择）
      ——回执：c6cd13a + 走查 7050b51（sync 数据态 PASS）
- [x] 测试：全部 sync Scenario（单向跟随/非重叠自动合并/重叠 hunk 决议/
      CAS 并发/闭包缺失/显式中止 staging/type 冲突/mode 三方竞争/超限整
      push 拒/四边界崩溃+半写区分/扫描后编辑保护/中断恢复/seed 阻断）
      ——回执：c6cd13a + 真双机缺陷修复链 94806e2/c5f5cb6（F6 数据丢失级）
      /ef9c314（F7）+ transport 包络五组事实 5a09aa1 + r9-B1 四类确定性竞态
      测试（本提交，见下条）
- [x] r9-B1（归档阻塞闭合，2026-09-29）：scanWorktree/pathStateTuple 受控
      fd 读取——open(O_RDONLY|O_NONBLOCK|O_NOFOLLOW)+fstat 复核+有界读
      （累计>1MiB 即刻 oversize-history）+读毕长度复核；目录递归 verified-walk
      锚定（O_DIRECTORY|O_NOFOLLOW+dev/ino 身份复核，复用 ext-files 先例）；
      opts.readHook 确定性注入四类竞态测试（预检后增长/文件换 symlink/目录换
      symlink/分诊期间替换）——ext-sync 全量 74/74（基线 67+新增 7）
- [x] 双机验收矩阵：agents-skills 真目录全故事（iMac+Mac mini）
      ——回执：第六批 9/9 矩阵+7 缺陷 5 修复（8379408）+第七批复放 4/4 与
      E1′ 六层闭合（8de7e8a/07596d7）+第八批超限/恢复路径（5a09aa1）

## 5. 收官

- [x] 既有面全量回归（webui/opendweb/tray/client-sdk 全套）+ strict×2
      ——归档前终跑回执（2026-10-01，HEAD b9678ec/728e82a 链）：cargo
      dweb-fabric 338/0（单线程）+ workspace 654/0；client-sdk 99/99、webui
      262/262（连续三次全量绿，含 B5 修复 35eb0e4 后）、ext-ports 43/43、
      ext-files 59/59、ext-sync 74/74；clippy --all-targets -D warnings 0；
      openspec strict 通过；.node 重建 md5 68bea736 双端一致
- [x] Codex 实现终验（全部裁决+协议边界 Scenario 证据+双机验收记录）
      ——评审链全程 r7 7.0→r8 8.4→r9 8.8→r10 GO 9.2→r11 8.2→r12 8.5→r13
      8.0/8.7→r14 8.3（触发算法升级规则转日曜三实现 728e82a）→r15 实现面
      GO 9.3（4d6643c）→r16 发布前置维持（d24c068）→**r17 发布 GO**（a3b065e：
      反转拓扑矩阵 run2 回执 24/24 有效、VIOLATIONS=0、RECOVERY-FAILED=0、
      INVALID-INJECT=0，回执 /tmp/wpk-matrix-rev.log 已由 Codex 独立核验）
- [x] Owner 双机实走包（walkthrough 文档+脚本）
      ——文档+自检脚本 5/5（5d144d4）；归档日编排者 ego-browser 活环境走查
      通过（控制台加载/插件面板 ports 已启用/端口映射项"mini 8080 rev 已启用
      监听中 localhost:19090→71ymwthn…:8080"实时显示/「即将推出」占位在位）；
      Owner 本人实走保留为后置追认项（kit 就绪随时可走）
- [ ] [W7]-[W11] Owner 追认记录（W11 旧 --token 入口例外与否）
      ——状态：待 Owner 追认（W11 安全默认：既有 --token/DWEB_ADMIN_TOKEN
      受控例外披露在案，本 change 新面零 argv 凭证）；[W7]-[W10] 为推荐默认
      已按文落地（W7 1MiB 包络 5a09aa1/W8 双机 pairwise/W9 seed authority/
      W10 安装仅 CLI）——追认记录待补
- [x] [W12] 数据面 fabric 默认 direct-only（relay 条目仅诊断/显式提供）
      ——已裁决并落地：Codex r7 B1 approve（0206ade）→实现于第四轮双机验证
      （design §9.1「W12 落地记录」；直连 md5 等价+签名面零 relay 实证）→
      r8 确认闭合（eec887b）
