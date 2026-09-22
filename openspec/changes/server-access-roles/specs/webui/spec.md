## ADDED Requirements

### Requirement: 三角色管理台信息架构

WebUI SHALL 以三角色心智模型（管理员/租户/访客）组织管理台，在 webui-console 冻结的 sidecar/token 边界/配对流程基座上演进。导航 SHALL 为：**总览**（四问：谁在线/有几个租户/有没有人敲门/邀请码状态 + 待办条）、**租户管理**（租户名册 + 别名 + 到期 + 续期 + 邀请码管理）、**访客与门禁**（敲门台 + 访客名册 + 黑名单）、**在线连接**（既有视图）。节点切换入口 SHALL 位于右上角节点信息区（见"节点簿与节点切换"），一次只呈现一个当前节点。术语：UI 呈现层 SHALL 使用「租户」指称 owner/fabric root、「访客」指称 visitor（术语映射在文档中单点定义；「包租婆」等比喻 MUST NOT 出现在操作文案中，仅限教育性引导文案）。既有 hash 路由 MUST 收敛到新 IA（旧路径重定向，不 404）。

#### Scenario: 旧路由收敛

- **WHEN** 访问 webui-console 时代的旧 hash 路由（如 #/owners）
- **THEN** 重定向到新 IA 对应页（租户管理），不出现 404 或空白

#### Scenario: 总览四问一次可读

- **WHEN** 管理员打开总览页且服务端各计数非零
- **THEN** 同屏呈现：在线连接数（含访客在线）、租户数（active）、待处理敲门数、可用邀请码数；待处理敲门 >0 时有待办引导条直达敲门台

#### Scenario: 敲门待办的导航入口

- **WHEN** 存在未处置敲门
- **THEN** 「访客与门禁」导航项呈现计数徽标，点击进入敲门台

### Requirement: 敲门台（待办处置）

WebUI SHALL 提供敲门台页：列表呈现聚合敲门（谁（key 缩写/别名）/次数/首次/最近/原因），未处置在前、最近在前；每行提供四个动作，成品文案采用 PRODUCT-DESIGN §4 冻结稿：**定位访客**（预填 endpoint_id 的访客授权表单 + 确认）、**导入租户**（租户注册表单——敲门记录无 fabric 归属，表单 MUST 提示「敲门记录只有敲门人的钥匙，没有房间号：请用邀请码让 TA 自助注册，或手工输入 fabric_id+root」）、**拉黑**（二次确认后加入黑名单）、**忽略**（dismiss + 带「撤销」入口的 toast）。列表数据经 `/sidecar/*` 同源代理取自 `GET /admin/knocks`；四个动作分别调用对应 admin 路由，失败走既有六类错误态渲染。

#### Scenario: 一键定位访客全链路

- **WHEN** 管理员在某敲门行点「定位访客」，确认表单（endpoint_id 已预填、可补别名）
- **THEN** 调用访客授权成功后该敲门从待办消失（或标记已处置），敲门者重连 relay 即放行

#### Scenario: 导入租户的引导而非阻断

- **WHEN** 管理员点「导入租户」
- **THEN** 表单呈现引导文案（邀请码通道或手工输入二元组），不因敲门记录无 fabric 而阻断流程

#### Scenario: 忽略的撤销路径

- **WHEN** 点「忽略」后 toast 呈现，管理员在 toast 存续期内点「撤销」
- **THEN** 该敲门恢复未处置状态（dismiss 幂等语义下撤销等价再次进入待办视图）

### Requirement: key 显示规范（别名 + 防钓鱼缩写）

WebUI 全站 SHALL 统一 key 呈现为 `别名 (abc***xyz)`：缩写规则为 hex 的**首 3 字符 + `***` + 尾 3 字符**（区块链钱包式）；无别名时仅缩写。缩写元素 MUST 提供 title 提示全文与复制全文入口（复制的是完整 64 hex，不是缩写）。本规则**取代** webui-console 时代的首 8 位缩写规则（跨 change 规范更替，webui-console 归档时注明被本规范取代）。缩写 MUST 出现在一切列举 key 的位置（敲门台/访客名册/租户名册/在线连接/邀请码 alias_hint 提示）。

#### Scenario: 有别名与无别名的呈现

- **WHEN** 列表中同时存在带别名租户与无别名端点
- **THEN** 前者呈现 `别名 (abc***xyz)`，后者呈现 `(abc***xyz)`；两者的复制入口均复制完整 64 hex

#### Scenario: 复制不含缩写混淆

- **WHEN** 管理员复制任一 key 缩写元素
- **THEN** 粘贴结果为完整 64 hex（可用于 admin 路由的路径参数）

### Requirement: 邀请码管理页

WebUI SHALL 在租户管理内提供邀请码管理：签发表单（备注 alias_hint 可选、次数默认 1、有效期默认 7 天、注册后默认有效期默认 30 天——均可改）；签发成功 MUST 以**仅此一次**的醒目视图呈现码全文（`dwebc1.` 前缀、4-4-4-4 分组）+ 复制按钮 + 「关闭后无法再次查看」警示；列表只呈现哈希缩写/计数（used/max）/状态（可用/耗尽/过期/已吊销）/到期；吊销为二次确认动作。列表与动作经 `/sidecar/*` 代理对应 admin 路由。

#### Scenario: 码全文仅签发时可见

- **WHEN** 签发成功后管理员离开签发结果视图再回列表
- **THEN** 列表与一切后续界面只呈现哈希缩写，无任何途径再次取回码全文

#### Scenario: 吊销的二次确认

- **WHEN** 管理员对可用码点「吊销」
- **THEN** 呈现二次确认（说明兑换将立即失效），确认后列表状态更新为已吊销

### Requirement: 节点簿与节点切换

sidecar SHALL 维护本地节点簿存储（`~/.opendweb/nodes.json`，权限 0600）：条目 `{id, name, server_host, token, added_at}`；**token 只存在 sidecar 侧，MUST NOT 出现在任何 HTTP 响应、日志或浏览器可达状态中**；`GET /sidecar/state` 与节点列表响应只含 `{id, name, server_host, added_at, current}`。节点添加经既有配对面流程（每次新配对码；validateTarget 全量校验与并发一次性消费语义不变），当前节点可多次重复添加新节点。节点切换 `POST /sidecar/nodes/switch {node_id}`：**MUST 仅接受已存储节点的 node_id**（任何 URL/host 字段一律 400——目标冻结安全模型保持，无"新目标注入"通道）；Host/Origin 校验与 connect 面一致；切换为进程内原子替换 target+token（无需重启 sidecar），响应后同源代理面即刻指向新节点。删除 `DELETE /sidecar/nodes/{id}`；当前连接节点不可删除（409，先切走）。UI：右上角节点信息区提供节点切换菜单（一次一个当前节点，无同屏多节点），切换中呈现过渡态。

#### Scenario: 切换仅限已存储节点

- **WHEN** `POST /sidecar/nodes/switch` body 为 `{node_id}` 之外的任何形态（含直接给 URL/host）
- **THEN** 返回 400，不发生任何出站连接；仅已存储 node_id 被接受

#### Scenario: 切换后代理面即刻指向新节点

- **WHEN** 切换到节点 B 成功后，浏览器立即请求 `/sidecar/api/status`
- **THEN** 请求被代理到节点 B 的 admin 面（响应反映 B 的状态）

#### Scenario: token 永不出浏览器

- **WHEN** 调用 state/节点列表/切换/删除任一接口并审查响应与 sidecar 日志
- **THEN** 任何位置不含任何节点 token 明文

#### Scenario: 当前节点不可删除

- **WHEN** `DELETE /sidecar/nodes/{当前节点 id}`
- **THEN** 返回 409 错误 envelope；先切换到其他节点后方可删除
