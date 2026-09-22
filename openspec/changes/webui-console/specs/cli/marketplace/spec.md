## ADDED Requirements

### Requirement: 单命令插件折叠派发

自适应解析命中插件后，CLI SHALL 以插件名 token 之后的 argv 首 token 判定
派发形态：首 token 为 manifest 任一命令名（显式命令 token）时按既有语义派发
该命令；首 token 非命令 token（flag 或空 argv）且 manifest 恰声明一个命令时，
CLI SHALL 折叠派发该唯一命令——首 token 及其后全部作为该命令的 argv（省略
命令 token 的一键直达形态）。多命令 manifest MUST NOT 折叠：非命令首 token
按既有错误路径非零退出并列出可用命令。折叠 MUST NOT 改变 builtin 关键字优先
于自适应解析的次序，MUST NOT 影响 `--help` 零执行（`opendweb <name> --help`
仍仅依据清单渲染用法，不执行插件 run）。

#### Scenario: 单命令插件省略命令 token 直达

- **WHEN** 已安装的单命令插件（manifest 仅声明一个命令，如 `opendweb-webui`
  的 `webui`）以 flag 首 token 调用：`opendweb webui --server https://srv.example:18787`
- **THEN** 折叠派发唯一命令 `webui`，`--server ...` 作为命令 argv，行为与
  `opendweb webui webui --server https://srv.example:18787` 完全一致

#### Scenario: 空 argv 同样折叠直达

- **WHEN** 单命令插件以空 argv 调用：`opendweb webui`
- **THEN** 折叠派发唯一命令（argv 为空）；命令缺省参数语义（如缺省
  `--server` 进入 setup 模式）由命令实现自担，多命令 manifest 的空 argv
  help 渲染行为不变

#### Scenario: 多命令 manifest 不折叠报可用命令

- **WHEN** 多命令插件以非命令首 token 调用，如 `opendweb echo --loud`
- **THEN** 不折叠，按既有错误路径非零退出并列出可用命令
  （available: hello, fail）

#### Scenario: 折叠不影响 --help 零执行

- **WHEN** 单命令插件执行 `opendweb webui --help`
- **THEN** 输出基于清单声明的用法说明，不执行插件 run（折叠只改变命令
  token 的判定，不改变 help 渲染的零执行路径）

#### Scenario: 显式命令 token 形态仍可用

- **WHEN** 单命令插件执行 `opendweb webui webui --server https://srv.example:18787`
- **THEN** 首命令 token 命中 manifest 命令名，按既有显式形态派发，行为
  与折叠形态等价
