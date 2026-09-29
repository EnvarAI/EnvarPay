# EnvarPay — 让 Agent 能收款，也能付款

**EnvarPay** 是开源的 Python SDK + CLI，使用官方 MCP 和 x402 v2 SDK。

[English](README.md) · [MIT 许可证](LICENSE) · [真实测试链付款 POC](docs/proof-of-concept.md)

按你使用的 Agent 查看：[OpenClaw](docs/integrations/openclaw.md) ·
[Hermes](docs/integrations/hermes.md) · [OpenCode](docs/integrations/other-runtimes.md#opencode) ·
[Goose](docs/integrations/other-runtimes.md#goose) · [开发框架](docs/integrations/other-runtimes.md#langgraph-and-langchain)。
先看[支持矩阵](docs/integrations/index.md)：Hermes 的钱包接入与嵌入式执行已测试，
其他框架目前是经官方接口核实的接入候选，尚无新的跨框架付款验收。
`0.1.0a2` 是未发布的源码预览；不是 Hermes 官方插件，也尚未发布到 PyPI。

## 安装

```sh
git clone https://github.com/EnvarAI/EnvarPay.git
cd EnvarPay
python -m pip install .
envarpay --help
```

只有选择嵌入式 Hermes 收款模式时，才用 **Hermes 自己的兼容 Python 环境** 安装：

```sh
uv pip install --python /path/to/hermes/.venv/bin/python /path/to/EnvarPay
```

不改 Hermes 源码。买方钱包或现有 MCP 服务的收费代理可以独立运行，不需要安装 Hermes。
测试使用的 Hermes 0.20.0 为 uv 设置了 14 天依赖发布等待期。如果因此无法安装固定的
x402 2.24.0，可参照示例 Dockerfile，仅为该版本加
`--exclude-newer-package x402=2026-09-29T23:59:59Z`；其他依赖仍遵守原等待期。

## 我要收钱

```sh
envarpay init --directory ./agent-pay --pay-to 你的完整收款地址 --backend openclaw
# 已有 Hermes API 服务时，把 backend 改成 hermes-http。
```

编辑生成的 `seller.toml`，填写已有 Agent 服务地址、固定 Agent 目标和收款价格。
模型和工具继续在原 Agent 中配置。通过 `ENVARPAY_RUNTIME_TOKEN` 提供专用服务凭据，
或者配置权限为 0600 的 `api_key_file`。原始 Agent 服务保持私有，只公开收费入口。
价格 `amount_atomic = 10000` 表示 0.01 USDC。

```sh
envarpay doctor --config ./agent-pay/seller.toml --online
envarpay serve --config ./agent-pay/seller.toml
```

此时 `http://127.0.0.1:4020/mcp` 提供收费的 `ask_agent` 工具，也支持 `/sse`。
对方未付款就得到 PaymentRequired；确认收款后才调用原 Agent 执行。
收款只配置地址，不配置收款私钥。
已有服务的 HTTP 连接器仍是实验功能，两条路径尚待真实运行时付款验收，
具体启用方式参见 [OpenClaw](docs/integrations/openclaw.md) 和 [Hermes](docs/integrations/hermes.md)。
另有可选 `--backend hermes` 嵌入模式，会新建 `AIAgent`，跳过记忆与工作区上下文；
它不会接入你正在使用的会话。

如果已经有 MCP 服务，初始化时选 `--backend mcp`，把上游地址、出售的工具名和价格
写入配置即可。公网地址和 HTTPS 需要自行提供，并避免把未收费的上游执行入口公开。

## 我要付钱

```sh
envarpay keygen --output ./agent-pay/buyer.key
```

命令只显示钱包地址，密钥保存在本地文件；已有密钥不会覆盖。
默认配置是 **Base Sepolia 测试网、单笔和累计均最多 0.01 测试 USDC、付款关闭**。
先给该钱包领取测试 USDC，检查 `buyer.toml` 中的网络、完整卖方地址、工具名单和预算，
再设置 `payments_enabled = true`。

```sh
envarpay host-config --host hermes --config ./agent-pay/buyer.toml
```

把输出的 `mcp_servers.envarpay` 条目合并进 Hermes 的 MCP 配置，然后重新加载 Hermes。
这个命令只生成配置，不修改你的个人配置文件。若依赖代理或服务凭据环境变量，
在 Hermes 的该 MCP 条目里显式配置 `env`；不要把钱包私钥交给模型。

Hermes 将获得三种工具：发现配置中卖家的工具、按预算调用付费工具、查看付款状态。
也可以直接调用 CLI：

```sh
envarpay call --config ./agent-pay/buyer.toml --peer seller --tool ask_agent \
  --arguments '{"question":"帮我设计一次团队知识复盘"}' --request-id review-001
```

同一任务重试沿用同一 `request-id`。有结果就返回已保存结果；结果未知时拒绝再次签名。
累计预算保存在本地数据库，不因重启而清零。新请求 ID 代表另一笔购买。

```sh
envarpay status --config ./agent-pay/buyer.toml --operation-id buy:review-001
envarpay reconcile --config ./agent-pay/buyer.toml --operation-id buy:review-001
```

状态与对账均不付款。对账需要已记录的交易哈希，不会自动重发授权或重跑任务。
保留状态目录，不要通过删除数据库解决未知结果。先付款后模型仍可能失败；
自动退款、争议处理、多机部署和托管钱包尚不在这个版本内。

完整配置、协议范围、部署限制和测试说明见 [完整指南](docs/getting-started.md)。

新版统一包名、命令和 Python import 为 `envarpay`。已有 0.1.0a1 发布包不变；升级请保留钱包、原授权和预算账本，参见[迁移说明](docs/migration-envarpay.md)。

参见[实测记录](docs/integrations/validation.md)：OpenCode 本机原生 MCP 连接通过；Hermes 本机缺可选 MCP 依赖；OpenClaw 本机版本较旧；其余框架尚待运行时验收。没有新增跨框架链上付款。
