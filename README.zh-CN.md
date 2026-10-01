# EnvarPay — 让你的 Agent 能付款，也能收款

**EnvarPay** 是 Python SDK + CLI，使用官方 **MCP + x402 v2** SDK 和 USDC。
给现有 Agent 加一个受预算约束的钱包工具，或者给它的能力加上“确认付款后才执行”的入口。
Agent 继续使用自己的框架、模型和工具，无需 Envar 账号。

[English](README.md) · [完整入门](docs/getting-started.md) · [配置参考](docs/configuration.md) · [真实付款证据](docs/integrations/validation.md)

## 支持哪些 Agent？

| Agent | 给别人付款 | 给自己的能力收款 | 详细指南 |
|---|---|---|---|
| **OpenClaw** | 原生 MCP 钱包配置 | 原生 CLI/MCP 适配器 + 收款门禁 | [OpenClaw](docs/integrations/openclaw.md) |
| **Hermes** | 原生 MCP 钱包配置 | 原生 CLI/MCP 适配器 + 收款门禁 | [Hermes](docs/integrations/hermes.md) |
| **OpenCode** | 原生本地 MCP 配置 | 原生 CLI/MCP 适配器 + 收款门禁 | [OpenCode](docs/integrations/opencode.md) |
| **Goose** | 原生 STDIO 扩展 | 无界面运行模式的 MCP 适配器 + 收款门禁 | [Goose](docs/integrations/goose.md) |
| **LangGraph / LangChain** | 官方 `MCPAdapter` | 把 graph/agent 调用包装成私有 MCP 工具 | [LangGraph](docs/integrations/langgraph.md) |
| **Pydantic AI** | 官方 `MCPToolset` | 把 `Agent.run()` 包装成私有 MCP 工具 | [Pydantic AI](docs/integrations/pydantic-ai.md) |
| **其他 MCP 客户端/服务** | 启动标准钱包 MCP 进程 | 给已有 MCP 工具定价 | [通用 MCP](docs/integrations/index.md) |

六类框架都已在本机 Docker 中实际收付款，使用该轮核对的官方主开发分支源码。
**30 个有向组合中，28 个完成真实付款和交付，2 个结算失败**，逐笔结果保留在验收矩阵中。
已有 OpenClaw/Hermes Gateway 的 HTTP 连接器另属实验路径，不能借用这轮 MCP 实付结果声称通过。

## 安装

当前已实现的是 Python SDK/CLI，任何支持 MCP 的 Agent 都可以连接它。
安装 [uv](https://docs.astral.sh/uv/getting-started/installation/) 后，一条命令装入持久隔离环境：

```sh
uv tool install --python 3.13 'git+https://github.com/EnvarAI/EnvarPay.git@f794729106d1c80543e179c395899c497c6e01f0'
envarpay --version
```

这是固定到已审查的 `0.1.0a5` 安全修复提交的 **Git 源码安装**，不需要手工克隆和激活 venv。
本分发改进准备的是未发布的 `0.1.0a6` 候选。
2026-09-30 核对时，PyPI 和 npm 上都没有 `envarpay` 项目；GitHub 已有 `0.1.0a3` 预发布。
不能把 GitHub Release 当作 PyPI/npm 已上架，也不能把普通 MCP 配置称为原生插件。

仓库另有不捆绑 Agent 的独立服务 [Dockerfile](Dockerfile)。PyPI 发布流程已准备，
仍需项目 owner 绑定可信发布者后正式发布；npm TypeScript SDK 与原生插件尚未实现。
[各语言该装什么、当前分发状态和发布方案 →](docs/packages.md)

已有钱包升级请先读[迁移说明](docs/migration-envarpay.md)，保留原账本和密钥路径。

## 我要让 Agent 给别人付款

准备卖家的 **收费 MCP 地址、完整收款钱包地址、工具名**。以 Hermes 为例：

```sh
envarpay init --agent hermes --role buyer --directory ./my-wallet \
  --peer-url https://seller.example/mcp --pay-to 卖家的完整钱包地址 \
  --max-per-call 0.01 --budget 0.05
```

命令生成 `buyer.toml`、`host-config.json`、`wallet-command.json` 和 `SETUP.md`，
并直接显示网络、完整收款地址和预算。它不会创建密钥或发起付款。

1. 执行 `envarpay keygen --output ./my-wallet/buyer.key`，给显示的专用地址领取 **Base Sepolia 测试 USDC**。
2. 核对 `buyer.toml`，再主动设置 `payments_enabled = true`。
3. 将 `host-config.json` 中的条目合并进现有 Agent 配置并重新加载。Python 框架通过官方适配器读取 `wallet-command.json`。
4. 执行 `envarpay doctor --config ./my-wallet/buyer.toml` 查看实际配置。

Agent 会获得四个核心工具：

| 工具 | 作用 |
|---|---|
| `list_paid_tools` | 查询配置中卖家的允许工具 |
| `call_paid_tool` | 按收款方、工具白名单和预算购买能力 |
| `payment_status` | 查看已有付款状态，不重新签名 |
| `recover_payment` | 向已批准、支持恢复的卖方查询并恢复原操作或结果 |

其他框架只需更换 `--agent`，具体配置文件位置见上面的独立指南。
同一笔购买沿用同一个请求 ID，例如 `review-001`。未知结果不能换 ID 盲目重付。

## 我要让 Agent 的能力收费

准备 **自己的收款地址、私有 MCP 能力入口、工具名和价格**：

```sh
envarpay init --agent hermes --role seller --directory ./my-service \
  --pay-to 自己的完整收款地址 \
  --upstream http://127.0.0.1:8000/mcp --tool ask_agent --price 0.01

envarpay doctor --config ./my-service/seller.toml
envarpay serve --config ./my-service/seller.toml
```

启动后，收费入口为 `http://127.0.0.1:4020/mcp`，也支持 `/sse`。
对方先收到 x402 PaymentRequired；实际结算并核验精确到账记录后，才调用原 Agent。
收款服务只需要收款地址，**不需要卖方私钥**。

如果 Agent 还没有 MCP 服务入口，用对应指南里的原生 CLI 或 Python 包装示例。
`--agent` 用于选择指南及客户端配置，不会自动安装 Agent、暴露个人会话或替你托管服务。
原始执行入口保持私有，只对外提供经过 HTTPS 的收款门禁。

![Agent 付款与交付流程](assets/payment-flow.svg)

## 同一个 Agent 同时付款和收款

自己的收款地址与对方地址分开填写：

```sh
envarpay init --agent openclaw --role both --directory ./agent-pay \
  --pay-to 自己的完整收款地址 --price 0.01 \
  --upstream http://127.0.0.1:8000/mcp \
  --peer-url https://other-seller.example/mcp --peer-pay-to 对方完整收款地址 \
  --max-per-call 0.01 --budget 0.05
```

生成独立的 `buyer.toml` 和 `seller.toml`，使用不同状态目录。
按 `SETUP.md` 启动收款门禁、连接钱包即可；模型仍在原 Agent 中配置。

已有服务只需私有认证交互、暂不涉及付款时，可用 `--mode private`，
无需收款钱包，详见[私有服务接入](docs/getting-started.md#connect-a-private-existing-service)。

## 配置一览

| 你要设置的内容 | 参数 | 效果 |
|---|---|---|
| Agent 和角色 | `--agent`、`--role buyer/seller/both` | 只生成需要的配置和接入说明 |
| 收款地址 | `--pay-to`、双角色下的 `--peer-pay-to` | 固定完整收款方 |
| 出售的能力 | `--upstream`、`--tool` | 私有 MCP 服务和工具名 |
| 单次售价 | `--price 0.01` | 0.01 USDC，保存为 10000 atomic |
| 付款上限 | `--max-per-call 0.01 --budget 0.05` | 单次 0.01、累计 0.05 USDC |
| 是否允许付款 | 核对 `buyer.toml` | 默认 `payments_enabled = false` |

命令行金额直接按 USDC 填写，最多六位小数，不会四舍五入。预算累计保存在状态目录中，
重启不会清零。初始化不会覆盖非空目录，也不会修改你的个人 Agent 配置。

[完整配置参考](docs/configuration.md) · [Python SDK](docs/python-sdk.md) ·
[Python 框架完整示例](examples/integrations/python_agents.py) · [原生 Docker 示例](examples/cross-framework/README.md)

## 当前边界

EnvarPay 是独立的 Alpha 项目。MCP 和 x402 是标准协议；EnvarPay 提供配置、预算、
状态保存和付款后执行的封装。本次入驻体验更新没有发起新的链上付款。

默认是 Base Sepolia 测试网、付款关闭、单笔和累计各 0.01 测试 USDC。
可选的 Envar 连接提供目录发现和持久化上报；发现结果不自动取得付款权限。
原操作恢复需要明确批准的卖方恢复能力，见[目录与恢复指南](docs/directory-and-recovery.md)。
主网生产验收、退款、托管隔离保证、通用 A2A 编排及交付质量保证尚不包含在内。
发生未知结果时保留原签名和账本，详见[付款与失败语义](docs/getting-started.md#payment-and-failure-semantics)。

[贡献指南](CONTRIBUTING.md) · [MIT 许可证](LICENSE)

## 实验性任务托管

任务托管候选版本见[任务文档](docs/tasks/README.md)，与现有 x402 预付调用分开。
当前不支持主网；[五个 Base Sepolia 托管用例](docs/tasks/testnet-acceptance.md)
已通过，包括原生 Agent 交付、拒绝/超时退款及原交易恢复。
