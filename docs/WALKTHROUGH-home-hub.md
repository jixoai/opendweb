# home-hub 实际走查手册（Owner 版）

> 目标：亲手把「家庭中枢」的故事走一遍——
> 把一台机器变成家里的中枢 → 家里人输一串邀请码就连上 →
> 你在中枢台看到每位成员 → 中枢停机/重启，成员侧不慌 → 收得干净。
>
> 两种玩法：
> - **快速体验**（默认）：全程隔离目录（/tmp），玩完 `clean` 一键清空，不碰 `~/.opendweb`；
> - **真实安装**：去掉隔离环境变量照抄同样的命令，这台机器就正式成为家里的中枢。
>
> 全程你**看不到也不会输入 admin token**——它只存在中枢机器的 0600 文件里，
> 由命令链自己注入。这不是漏掉了，是设计。

## 准备

- 仓库（merge 后的 main 或 worktree 均可），以下命令都在仓库根目录执行；
- 两个终端：终端 1 = 中枢宿主，终端 2 = 家庭成员（同一台机器模拟，目录隔离）；
- 想玩真双机：文末附录 A。

---

## 第一幕 · 把这台机器变成中枢（终端 1）

```sh
./scripts/walkthrough/home-hub-demo.sh hub-init
```

它会（隔离模式下自动加 `--yes`）：预设家庭模式 → 自检端口/防火墙 → 打印**接入卡片**
（局域网地址 + `dwebh1.` 短码 + ASCII 二维码 + 家里人怎么连的三步）。

> 想体验交互问答版：`DWEB_HOME=/tmp/hh-demo-hub node packages/opendweb/bin/opendweb.mjs hub init`（不带 --yes）。

接着启动中枢并打开管理台：

```sh
./scripts/walkthrough/home-hub-demo.sh hub-start
./scripts/walkthrough/home-hub-demo.sh hub-open     # 浏览器自动打开中枢总览
```

浏览器里（中枢视角「我的中枢」）应看到：接入卡片置顶（和终端里同一张）、
中枢状态卡（运行中/地址/自启状态）、左侧三视角切换（我的中枢/我的租约/我的到访）。

> `hub-open` 的管理台地址是本机 sidecar（如 http://127.0.0.1:18950）——admin 凭据
> 只在这个本机进程里，不进浏览器、不进 URL。

## 第二幕 · 发一张邀请（浏览器）

中枢视角 → 租户管理 → 邀请码 → **签发**。

弹窗里的邀请码（`dwebc1.` 开头）**全文只显示这一次**，复制它。
（这就是「包租婆签发、租户自助」的那张票：默认 1 次/7 天。）

## 第三幕 · 家里人加入（终端 2）

```sh
# 先拿到接入短码（终端 1 里 ./scripts/walkthrough/home-hub-demo.sh hub-card 可重看）
./scripts/walkthrough/home-hub-demo.sh member-join 'dwebc1.<粘贴邀请码>' '妈妈的iPad'
```

实际执行的等价命令（理解用）：

```sh
DWEB_HOME=/tmp/hh-demo-member node packages/opendweb/bin/opendweb.mjs join \
  --server dwebh1.<接入短码> --code dwebc1.<邀请码> \
  --alias '妈妈的iPad' --allow-insecure
```

要点（都会在输出里体现）：

- `--server` 直接吃**接入短码**（离线解码成局域网地址，输错格式会零网络拒绝）；
- 家庭局域网是 http → `--allow-insecure` 是预期内的（见文末「明文告警」）；
- 成功后**不打印邀请码、不打印私钥**；租约落在成员侧 `leases.json`。

然后打开**成员自己的控制台**：

```sh
./scripts/walkthrough/home-hub-demo.sh member-ui
```

浏览器里（成员视角「我的租约」）应看到：这条租约（中枢地址/到期倒计时/连接状态
「直连中」或「借道中」）、可改的备注名（label，改完重启还在，清空即恢复默认）、
「我的到访」页脚说明。**成员视角没有中枢设置页**——成员不该管服务器，这是分权。

## 第四幕 · 中枢看到成员（浏览器，终端 1 的管理台）

- 租户管理 → 名册里出现成员（别名「妈妈的iPad」；若成员没自报别名，默认=对方机器名）；
- 在线连接 → 该端点在线、角色=租户；
- [H6] 联动：成员侧改 label 只影响成员自己的显示；中枢名册的 alias 是中枢侧的称呼——
  两层各叫各的，互不覆盖。

## 第五幕 · 中枢的生命周期（终端 1）

```sh
./scripts/walkthrough/home-hub-demo.sh hub-status
./scripts/walkthrough/home-hub-demo.sh hub-stop      # 成员台这时显示「连不上≠被拒」，不弹错误
./scripts/walkthrough/home-hub-demo.sh hub-start     # 中枢回来
```

- 停机期间：**直连中的会话不断**（成员侧继续用）；借道（relay）会话约 30~45s 断开、
  中枢回来后 ~21s 内自动重连——成员侧文案全程是状态说明，不是报错；
- 开机自启（真实安装时才有意义）：`hub-autostart-on`，`--print` 可先看生成的服务文件
  （服务文件里没有 token、没有数据目录路径——链启动时注入）。

## 第六幕 · 到访者敲门（可选，接 server-access-roles 故事）

```sh
node scripts/walkthrough/knock.mjs --relay http://<中枢局域网IP>:3340
# 不带 --gateway/--token 也能敲（只是终端 2 不做在线轮询自检）
```

中枢管理台 → 访客与门禁 → 敲门台出现陌生设备 → 「定位为访客」→ 对方进楼（可解析、
不可登记资源）。到访者身份记录在成员侧「我的到访」。

## 收尾

```sh
./scripts/walkthrough/home-hub-demo.sh clean
```

停中枢 + 删两个演示目录；`lsof -ti :8787 :3340` 应为空。

---

## 附录 A · 真双机

1. 中枢机：真实安装（不带 DWEB_HOME 前缀）`opendweb hub init && opendweb hub start`；
2. 成员机：装同一版本后 `opendweb join --server dwebh1.<卡片短码> --code dwebc1.<邀请码> --allow-insecure`，
   然后 `opendweb-webui`（成员视角自动出现）；
3. 短码编码的是中枢机的局域网 IP+端口——IP 变了重新 `hub card` 拿新码。

## 附录 B · 深度体验（可选）

- **G-3 停机观察**：成员侧开着「直连中」会话 → `hub stop` → 会话存活；纯借道场景
  断 30~45s、自愈 ~21s（自动化实测记录见 docs/acceptance-home-hub-g3.md）；
- **托盘心跳**：`node packages/tray/bin.mjs`（stdout 事件流；`--ipc` 为 JSON-RPC 模式）。

## 明文告警与安全红线

- 家庭中枢默认 http（局域网内），成员侧 join 的 `--allow-insecure` 与管理台顶栏的
  明文提示都是**预期内**的告知，不是漏洞告警；未来 IPv6/https 是升级路径；
- admin token / hub-token：0600 文件、链内注入，**永不**出现在浏览器、URL、argv、
  日志、IPC 帧里——走查全程可以随手验证这一点；
- 邀请码默认一次性/7 天过期；租约到期成员侧明确显示倒计时与到期文案。
