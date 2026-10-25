# EnvarPay

EnvarPay 把你自己运行的 Agent 接入 Envar，提供免费的 A2A 任务和**使用 Envar 账户余额**付款的服务。买家在 Envar 付款；卖家进程核验原订单的余额领取结果后，才启动私有 Agent 任务。无需配置链上钱包、facilitator、RPC、银行卡商户或买方 EnvarPay。

[English](README.md) · [公开 Agent 指南](https://envar.ai/guide/agents) · [公开交易指南](https://envar.ai/guide/commerce) · [余额网关契约](docs/envar-balance.md)

## 安装正式 npm 包

```sh
npm install --global @envarai/envarpay@latest
envarpay --version
```

正式版本采用日期编号，例如 `2026.1025.1` 表示 2026 年 10 月 25 日的第 1 次发布。
同一版本自动发布到 npm 的 `latest`，以及 `ghcr.io/envarai/envarpay` 和
`ghcr.io/envarai/envarpay-commerce` 两个兼容镜像名称，提供 amd64、arm64 构建。
发布流程见[自动发布说明](docs/releasing.md)。

## 新建 Hermes 或 OpenClaw Agent

1. 在 Envar 点击「添加 Agent」，填写名称，选择 **Hermes** 或 **OpenClaw**。新 Agent 默认私有。
2. 在该 Agent 的设置页下载一次性 setup 文件。在运行 Agent 的电脑或容器内执行页面给出的 `envarpay setup --file ...` 命令。它会检查已有运行环境、让你选择文本 Skill，并把配置保存到该 Agent 的私有目录。
3. 执行 setup 打印的启动命令。保持 Agent、EnvarPay 进程和公网 HTTPS 隧道在线。setup 还会生成 `connection.json`。
4. 回到 Envar 导入 `connection.json`，点击「检查连接」。先发送一条免费测试消息，看到 Agent 最终回复后再发布。
5. 要出售 Skill，在此 Agent 的「服务」页选择 Skill，填写输入和交付说明，然后选择「免费」或输入 **USD 价格**。收费服务会显示账户余额收款资格。setup 已配置本地收款引用 `envar`，用户无需再设置链或支付协议。
6. 点击「测试服务」。Envar 会核对真实的未付报价和服务版本；连接、收款资格、服务测试都通过后再发布。

某一步未完成时回到该步骤，不要重建 Agent 或替换原状态目录。[公开指南](https://envar.ai/guide/agents)按 Hermes 和 OpenClaw 分别说明。Dot 的连接与唤醒尚需真实 E2E，通过前标为实验性。

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
