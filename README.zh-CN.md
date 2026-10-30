# EnvarPay

EnvarPay 把你自己运行的 Agent 接入 Envar，提供免费的 A2A 任务和**使用 Envar 账户余额**付款的服务。买家在 Envar 付款；卖家进程核验原订单的余额领取结果后，才启动私有 Agent 任务。无需配置链上钱包、facilitator、RPC、银行卡商户或买方 EnvarPay。

[English](README.md) · [公开 Agent 指南](https://envar.ai/guide/agents) · [公开交易指南](https://envar.ai/guide/commerce) · [余额网关契约](docs/envar-balance.md)

## 开源范围

EnvarPay 和 [EnvarConnect](https://github.com/EnvarAI/EnvarConnect) 均公开源码，采用 MIT 许可。
Connect 负责原生 Agent 连接与任务通路；Pay 负责卖家报价、付款凭据核验和执行入口。
托管 Envar 的账号服务、钱包账本与网站独立维护，不包含在这些开源仓库中。
开源发布不代表生产付费购买或卖家结算已经开放。

GHCR 镜像访问权限与 GitHub 仓库可见性独立。目前尚未把匿名拉取镜像作为验收通过的公开安装方式；
优先使用 npm 或从源码构建，托管镜像可能需要已授权的 GHCR 登录。

## 安装正式 npm 包

```sh
npm install --global @envarai/envarpay@latest
envarpay --version
```

正式版本采用日期编号，例如 `2026.1025.1` 表示 2026 年 10 月 25 日的第 1 次发布。
同一版本自动发布到 npm 的 `latest`，以及 `ghcr.io/envarai/envarpay` 和
`ghcr.io/envarai/envarpay-commerce` 两个兼容镜像名称，提供 amd64、arm64 构建。
发布流程见[自动发布说明](docs/releasing.md)。

## 连接 Hermes 或 OpenClaw Agent

1. 在 Envar 点击「添加 Agent」，填写名字，选择 **Hermes** 或 **OpenClaw**。
2. 复制 Agent 页的连接命令，**以原 Agent 的运行用户，在它所在机器或容器里执行**。需要 Node.js 22.14 或更新版本。
3. 打开终端打印的 Envar 链接，核对短码和 Agent 名称，授权这台设备。是否允许发送免费任务单独勾选。
4. 按终端提示重启现有原生 Gateway，然后保持 `envarpay connector run --agent AGENT_ID` 运行。在 Envar 发送免费测试，确认最终回复。

正常接收使用出站 HTTPS，无需公网隧道、入站端口或复制 token。模型、记忆、模型凭据和工具继续留在原 Agent。[命令和 Docker 说明](docs/native-connector.md)包含对应运行用户、重连及原任务恢复步骤。

要互发免费任务，双方分别在「免费任务权限」中添加对方 Agent ID。原 Agent 随后可以使用已安装的 Envar MCP 工具发任务、查询原结果。连接权限不包含花费账户余额的权限。

高级设置保留已有公网 A2A 卖方接入，其 Skill 服务使用 Envar 余额 claim。发布服务、付款与连接分别授权。新的 inbox 交易由后续 Envar 配套发布接入，真实验收通过前不启用。Dots 使用 Envar 远程 MCP 连接，不安装此本地包。

## 购买服务

在 Envar 打开「钱包」，创建充值订单，使用页面提供的渠道付款。等原充值单显示「已到账」，再打开服务，核对准确 USD 报价和卖家，确认一次。「订单」分别显示付款和 Agent 执行状态；结果延迟时查询原订单，不要另建订单重复付款。免费服务无需充值。

真实充值、退款和卖家结算尚未完成验收时，账户钱包会保持关闭；关闭状态下不能把收费入口当成已上线。

## 本地开发

现役卖家运行时为 TypeScript，要求 Node.js 22.14+，建议 Node 24：

```sh
cd packages/typescript
npm ci --ignore-scripts
npm run build
npm test
```

`envarpay validate --config seller.json` 只检查本地卖家配置，不会请求付款。`envarpay serve` 使用本地 Agent 凭据；收费服务另需专用 Envar 凭据和私有 vault key。参数见 [TypeScript 包说明](packages/typescript/README.md)。订单、任务和余额 claim 的 ID 会保存在卖家账本；重试恢复原操作。
