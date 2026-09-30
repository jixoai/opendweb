# Tasks: webui-plugin-kernel

> 设计基线 v2.3（r6 GO 9/10）。纪律：每 Phase 绿门=对应包 node --test 全绿 +
> 既有 webui 套件零回归 + openspec validate --strict + git diff --check；
> 显式路径 git add（禁 -A/禁 amend during parallel）；测试 fixture 一律临时目录；
> 子进程显式回收留证。

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
- [x] 测试：生命周期 drain/摘牌、控制面四类 Origin 矩阵、路由接入四场景
      （可达/深链刷新/停用收敛/未知收敛+既有路由零变化）、双账本分离、
      既有 webui 全套零回归
      ——test/plugins-{host,sidecar,route}.test.mjs（30 用例；全套 225/225，
      基线 195 零回归）
- [x] dist 重建入库

## 2. Phase 1 —— ports 端口共享插件

- [ ] 包 `@jixo/opendweb-ext-ports`（workspace；`./opendweb-webui-plugin`
      descriptor + 运行时）；webui 静态注册
- [ ] 消费侧：映射账本 mappings.json（0600+锁）、本机 listener（仅 127.0.0.1，
      端口冲突明确报错）、逐请求 fetchHttp 代理（hop-by-hop 剥除清单+敏感头
      重写）、两阶段取消（头前 request.signal/头后 resp.abort→RESET→provider
      signal+上游 socket 收敛）、SSE 流式透传
- [ ] 提供侧：allowlist.json（(peer,remotePort) 默认 deny）+ `/wpk1/ports/
      proxy/<remotePort>` 端点（sessionId 隔离键+peer 授权）
- [ ] 限额：默认 1MiB 配置域 64KiB–1MiB/64KiB 粒度（r8-B4 包络收窄；超范围配置拒绝启动映射）、未知
      Content-Length 边读边累计拒绝、并发 ≤16+在飞预算 429
- [ ] UI：映射管理页（列表/新增/启停/删除）
- [ ] 测试：六 Scenario 全落（双机两阶段取消/已知超限 413/未知长度断开/
      并发 429+硬域/授权 deny/SSE+端口冲突）+ 单元面
- [ ] 双机验收：mini curl localhost:9090 ≡ iMac 8080（含 SSE+中途断开收敛）

## 3. Phase 2 —— files 文件夹共享插件

- [ ] 包 `@jixo/opendweb-ext-files`；共享账本 shares.json（默认 ro）
- [ ] 路径安全：root 目录 fd 冻结+逐组件 fd 链遍历（目录 O_DIRECTORY+
      O_NOFOLLOW 拒 symlink；macOS /dev/fd 组合；win32 等效为实现义务）
      +最终 fstat 复核；并发逃逸验收测试（攻击者循环替换 vs 并发请求，
      root 外零副作用）
- [ ] wire：list/stat/read（offset/len+OID etag）/PUT chunk（chunkHash 字段，
      服务端重算；同键同内容幂等/异内容拒/伪造拒）/commit（全片总长+整文件
      hash 校验后单次原子 rename）/mkdir/rename/delete（UI 确认）
- [ ] staging：uploadId 目录化+TTL 回收；.opendweb-ignore
- [ ] UI：文件浏览器页（浏览/面包屑/上传进度/下载/改名/删除；写按 mode+授权
      显隐）
- [ ] 测试：全部 files Scenario（浏览下载上传闭环/逃逸+竞态/断线续传+伪造+
      整文件摘要不符）+ 单元面
- [ ] 双机验收：mini 浏览/下载/上传 iMac 共享目录；中断不留半文件

## 4. Phase 3 —— sync 文件同步插件

- [ ] 包 `@jixo/opendweb-ext-sync`；isomorphic-git+node-diff3 依赖入包
- [ ] 组账本 groups.json+gitdir 布局（插件目录内）；多成员 ref 命名
      （refs/devices/<endpointId>/main+组收敛 ref）；[W9] seed authority UI
      （非空对端阻断+三方对照）
- [ ] 对象端点：GET refs/POST want/GET object/POST push；闭包校验（parent/
      tree/blob 全闭包，缺项拒绝+清单，ref 零变化）；超限 >1MiB（r8-B4 包络）commitLocal 预检 oversize-history 不写史+整 push
      原子拒绝
- [ ] ref CAS（expectedOldRef；不匹配拒绝提示重 fetch）+每 repo 单写者
- [ ] 自持三方树合并：分类 add/modify/delete/type/mode；文本 diff3
      （stringSeparator \n）；冲突分级 hunk（a/b/o 逐块选/编辑）vs 文件级
      （binary/超限/非 UTF-8/delete-modify/type/mode——保守规则：mode 变化与
      对端内容变化一律文件级）；ours/theirs endpointId 稳定排序；冲突记录
      持久化（base/ours/theirs OID+算法版本+决议）；merge driver 钩子位
- [ ] intent 事务协议：prepare（txId/target/路径操作清单含 preimage+postimage
      元组 OID·type·mode）→幂等物化（临时文件+fsync+rename）→CAS→done；
      恢复=ref 三态分诊（==targetCommit 逐路径只接受 postimage 否则不补 done
      保留 intent conflicted；==oldRef 路径三态分诊+物化+CAS；其他冲突停止）
      +路径三态（preimage 应用/postimage 已完成/其他=用户新改动保留转冲突）
- [ ] 调度：会话在线事件+30s 兜底+本地 debounce 2s；预算（1MiB/5000 对象/
      256MiB/2 流；closure wire ≤2MiB 流账预检）；任务状态机+UI 状态页
- [ ] UI：同步组管理/状态/冲突决议页（hunk 并排+选块+文件级选择）
- [ ] 测试：全部 sync Scenario（单向跟随/非重叠自动合并/重叠 hunk 决议/
      CAS 并发/闭包缺失/显式中止 staging/type 冲突/mode 三方竞争/超限整
      push 拒/四边界崩溃+半写区分/扫描后编辑保护/中断恢复/seed 阻断）
- [ ] 双机验收矩阵：agents-skills 真目录全故事（iMac+Mac mini）

## 5. 收官

- [ ] 既有面全量回归（webui/opendweb/tray/client-sdk 全套）+ strict×2
- [ ] Codex 实现终验（全部裁决+协议边界 Scenario 证据+双机验收记录）
- [ ] Owner 双机实走包（walkthrough 文档+脚本）
- [ ] [W7]-[W11] Owner 追认记录（W11 旧 --token 入口例外与否）
