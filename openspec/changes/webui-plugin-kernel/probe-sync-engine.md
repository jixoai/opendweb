# 同步引擎可行性实证（Q5 证据，2026-09-24 本机探针）

> 探针代码 /tmp/iso-probe/{probe.mjs,probe2.mjs}（会话工件，不入仓）。
> 结论先行：**isomorphic-git + 对象级传输 + node-diff3 的组合在真机验证成立**，
> 覆盖 [W3] 全部语义；无需实现 git smart HTTP server。

## 实证 1：对象级跨仓传输（无 git wire）

- readBlob/writeBlob、readTree/writeTree、readCommit/writeCommit 在两个独立
  gitdir 间搬运松散对象；**内容寻址逐字节一致**（oid 不匹配即抛错，全程零 mismatch，
  含嵌套子树递归）。
- 含义：同步传输面可以是一个**自定义轻端点**（refs + 缺失对象清单 + 松散对象流），
  借 fetchHttp/serveHttp 承载；SHA 天然去重（对端已有对象跳过）。
- 边界（如实）：松散对象无 pack 压缩/增量——configs/skills 量级（MB 级）无碍；
  大二进制场景（百 MB+）是后续优化位（pack 化列为非首发）。

## 实证 2：isomorphic-git 的 merge 边界（关键发现）

- `git.merge` 对 **bothModified 文件不做行级文本自动合并**：A 改第 1 行、B 改第
  3 行（经典可自动合并场景）仍抛 `MergeConflictError`。
- 但冲突结构干净：`{filepaths, bothModified, deleteByUs, deleteByTheirs}`——
  结构化冲突清单可直接喂 UI。
- 含义：**merge 编排要自持**——用 isomorphic-git 做对象/引用/提交底座，
  bothModified 的文本三方合并自己做（见实证 3），最后 writeTree+writeCommit
  完成合并提交（不用其 merge 命令的二分语义）。

## 实证 3：node-diff3 补齐 [W3] 全语义

| 场景 | 结果 |
|---|---|
| 不同区域改动同一文件 | 干净自动合并（regions=[{ok:[合并结果]}]） |
| 同一行不同改法 | 结构化冲突区 `{a:我方行, b:对方行, o:基线行}`——UI 可做选版本/并排 |
| 冲突标记文本 | `<<<<<<< ours / ======= / >>>>>>> theirs` git 风格可生成——[W3]「直接把 git merge 冲突的内容展示出来」 |

## 对 Q5 的更新（相对 design-notes-r1 候选路）

- 候选 b（自定义 refs+对象端点）从「不确定」升级为**已实证**；
- 候选 a（自实现 git smart HTTP）不再必要；
- 候选 c（gitoxide NAPI）工程前置成本不划算，降为远期大仓优化位；
- 候选 d（放弃 git 语义）与 [W3] 冲突，排除。
- 建议冻结：**引擎=isomorphic-git；传输=自定义对象同步端点（fetchHttp/serveHttp）；
  合并=自持三方树合并（对象 API + diff3）；AI merge=merge driver 钩子位**
  （diff3 冲突结构正是 AI 决策的天然输入）。
