# EnvarPay — 给现有 Agent 开启收款和付款

为现有 Agent 添加**受预算约束的钱包工具**、**先收款再执行的能力入口**，或者同时开启两者。
Agent 保留自己的框架、模型、工具和记忆。使用标准 MCP 与 x402 v2；不需要 Envar 账号，
也可以[接入 Envar](docs/envar.md) 做发现、收款配置和交易展示。

[English](README.md) · [完整入门](docs/getting-started.md) · [Envar 接入](docs/envar.md) · [各框架指南](docs/integrations/index.md)

## 两种付款方式

| 方式 | 付款与交付 | 接入方式 |
|---|---|---|
| 按次调用付费 | 确认付款后执行一个能力，返回结果 | MCP 工具、Python 钱包或 npm 客户端 |
| 按任务交付付费 | 托管资金、取成果、明确验收；拒绝或超时可发起退款 | 实验版 Python 任务钱包和标准 MCP，仅 Base Sepolia |

收款、付款和两者兼有是角色；MCP/A2A 是接入协议。任务方式也提供 MCP 工具。
[Envar 接入指南](docs/envar.md) 将同一个 Agent 的私人入口、收费能力和钱包分开。
目录发现不自动授权付款；网页购买仍受本地白名单、原有预算和签名开关约束。
任务合约尚未审计，不开放主网。

## 应该装哪个？

| 需求 | 选择 | 职责 |
|---|---|---|
| 给任意支持 MCP 的 Agent 开启付款 | Python `envarpay` CLI/服务 | 钱包签名、收款方和工具白名单、预算、账本、恢复 |
| 给已有能力收款，不管 Agent 用什么语言 | Python `envarpay` 收款入口 | 报价、收款、核验到账后调用私有 MCP 工具；不需要卖方私钥 |
| Python 应用内编程调用 | Python `envarpay` API | `WalletService` / `PaidServer`，沿用 CLI 的策略和状态 |
| JS/TS 或 Bun 应用内调用 | npm `@envarai/envarpay` | 认证钱包 MCP 客户端；不在 npm 安装时偷偷装 Python，不内置签名器 |
| 宿主不适合嵌入任一种包 | 独立 MCP 服务 | 在单独进程、机器或自建容器中运行服务，Agent 使用自己的 MCP 客户端连接 |
| Agent 只有 HTTP API 或 CLI | 私有薄适配器 | 把一个明确的能力包装成 MCP，再放到收费入口后面 |

Python [0.1.0a11 已上架 PyPI](https://pypi.org/project/envarpay/0.1.0a11/)，
npm [@envarai/envarpay](https://www.npmjs.com/package/@envarai/envarpay) 已发布到 `next` alpha 渠道。
[分发渠道与版本](docs/packages.md)。OCI a11 镜像已发布但仍为私有；组织策略与匿名拉取验收完成前，
使用公开 Python 包或[从源码构建容器](docs/container.md)。

“任意 Agent”需要它能调用 MCP，或者有可被包装的 API/CLI；只有界面的应用需要另做接入。
协议可以兼容，不等于所有 Agent 的所有版本都做过实际付款验收。
当前六个框架的 30 个有向收付款组合都有测试网付款与交付证据：原 28 笔加 a11 的 2 笔补测；
这不是一次重新执行全部 30 个任务。见[真实验收范围](docs/integrations/validation.md)。

## 安装 Python 包

安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)，然后：

```sh
uv tool install --python 3.13 envarpay==0.1.0a11
envarpay --version
```

Python 应用自己的环境执行 `python -m pip install envarpay==0.1.0a11`。
当前是 alpha 版本。已有钱包升级时固定已验证版本，保留配置、密钥和账本，
不要重新初始化：[升级说明](docs/migration-envarpay.md)。

## 快速开启收款

先让现有 Agent 提供一个私有 MCP 工具，例如 `ask_agent`：

```sh
envarpay init --agent mcp --role seller --directory ./seller \
  --pay-to 你的完整收款地址 \
  --upstream http://127.0.0.1:8000/mcp --tool ask_agent --price 0.01
envarpay doctor --config ./seller/seller.toml
envarpay serve --config ./seller/seller.toml
```

收费入口是 `http://127.0.0.1:4020/mcp`。对外提供自己的 HTTPS 通道并配置允许的主机；
原始 Agent 工具保持私有。卖方只需要收款地址，不需要私钥。精确到账核验通过后才开始执行。
[已有 MCP、Python 函数及原生 CLI 的收款方案](docs/selling.md)。

**生成的配置默认使用 Base Sepolia 测试 USDC。** 要收真钱，必须显式核对 Base 主网、
官方 USDC、收款地址、价格、RPC 和支持该网络的 facilitator。
初始化和 `doctor` 不付款，也不代表实际交易已经验收：[配置参考](docs/configuration.md)。

## 快速开启付款

拿到卖方收费 MCP 地址、完整收款地址和准确工具名：

```sh
envarpay init --agent hermes --role buyer --directory ./buyer \
  --peer-url https://seller.example/mcp --pay-to 卖方完整收款地址 \
  --tool ask_agent --max-per-call 0.01 --budget 0.05
envarpay keygen --output ./buyer/buyer.key
envarpay doctor --config ./buyer/buyer.toml
```

为这个专用测试钱包准备资金，核对 `buyer.toml` 的链、收款方、工具和限额，再主动设置
`payments_enabled = true`。把生成的 `host-config.json` 合并进 Agent 的已有配置并重新加载；
其他 MCP 宿主使用 `wallet-command.json` 的 command/args。[框架具体步骤](docs/integrations/index.md)。

Agent 得到 `list_paid_tools`、`call_paid_tool`、`payment_status`、`recover_payment` 四个工具。
每次采购使用固定请求 ID；超时后查状态或恢复原请求，不能换 ID 再买一次。预算是累计额度，
不会每天重置。`--agent` 选择接入格式和指南，不会新建 Agent 或替换它的模型。

同时收付款时用 `--role both`：`--pay-to` 是自己的地址，`--peer-pay-to` 是其他卖方的地址；
两边保留独立配置和状态。

## JS/TS、Bun 和其他语言

安装已发布的 `@envarai/envarpay@0.1.0-alpha.3`，通过 `WalletClient.connect` 连接自己的认证钱包服务。
[完整 npm README](packages/typescript/README.md) 包含服务启动、Envar 发现、付款、查状态和恢复。
npm 包是钱包客户端；密钥、资金、预算仍在 Python 钱包服务中。

Rust、Go 等 Agent 直接用原生 MCP 客户端连接这个独立服务；不需要照搬一份该语言的签名和账本。
宿主不愿安装 Python，就把服务部署到别的进程/机器，或者按仓库 Dockerfile 自建镜像。
现成 MCP Agent 也可以直接连钱包，不必为了它是 JS 实现就强装 npm 包。

## 服务于 Envar 的哪些功能？

[Envar 接入指南](docs/envar.md)覆盖注册入口、证明控制权、发布收费能力、应用收款配置、
发现其他 Agent、受限采购、状态恢复和双方交易展示。
`[connection]` 开启目录与持久上报；卖方可选择 `accept_receiving_updates` 同步 Envar 收款设置。
发现一个 Agent 不会自动授权新收款方，也不会让模型修改钱包策略。

需要“锁款 → 异步执行 → 交付 → 验收放款或退款”时，用 Python `envarpay[task]`
和任务钱包的标准 MCP 工具。这是独立实验模式，目前只支持 Base Sepolia；
不会改变普通预付费调用的含义。[任务模式](docs/tasks/README.md)。

## 验收范围

六类框架的[测试网矩阵](docs/integrations/validation.md)现有 30 个方向的真实付款交付证据：
原 28 笔加 a11 的 2 笔补测。原 2 次失败和恢复记录保留；这不是一次重新执行全部 30 个任务。
安装、Node/Bun 传输测试和 CI 不增加真实付款次数；HTTP 连接器和任务托管各有验收范围。

钱包密钥、策略和账本放在钱包自己的权限边界内；和可任意执行 shell 的 Agent 共用系统用户，
不构成密钥隔离。预付后执行仍可能失败，普通调用不会自动退款；保留原始请求和状态：
[付款、执行与恢复](docs/directory-and-recovery.md)。

[Python API](docs/python-sdk.md) · [配置](docs/configuration.md) · [安全](SECURITY.md)
