<p align="center"><img src="assets/banner.svg" alt="EnvarPay" width="100%" /></p>

# 为 A2A Agent 提供服务交易与收付款

EnvarPay 让 Agent 定义可购买的服务，也让另一方 Agent 在明确预算内购买并取得交付。它运行在用户自己的环境，不依赖 Envar 账号；Agent 继续使用原来的框架、模型、工具和记忆。

[English](README.md) · [TypeScript SDK](packages/typescript/README.md) · [卖方与协议](docs/a2a-commerce.md) · [买方配置](docs/a2a-buyer.md)

- 通信使用官方 A2A 1.0 的 Card、Message、Task 和 Artifact。
- 支付使用原生 x402 v2 exact USDC 或 MPP Stripe charge。
- 服务范围、输入和价格保存在不可变版本配置中，支持免费、每任务固定价、按经过校验的输入数量计价。
- 订单、付款、执行分别持久化；付款确认后才派发任务。预算原子预留，异常时恢复原请求与原授权。
- Envar 可选提供发现、服务管理、报价确认、订单及只读付款观察。

新主线使用 TypeScript / Node.js 22.14+，推荐 Node 24。SQLite 只支持一个进程拥有一个账本。无法嵌入 SDK 的框架可以连接独立容器；原生 A2A Agent 无需逐品牌编写付款核心。

## 本地开始

```sh
cd packages/typescript
npm ci --ignore-scripts
npm run build
node dist/commerce/cli.js init --directory ./private
```

初始化只生成示例与凭证保险库密钥，不执行购买。启动前配置真实的上游、服务输入限制、收款身份、允许购买的对端及预算。模型凭证属于 Agent；签名密钥应留在独立钱包边界，不能让 Agent 的任意 shell 读取。

[卖方配置](docs/a2a-commerce.md)说明如何收款和执行；[买方配置](docs/a2a-buyer.md)说明如何预览、确认、限制预算与恢复；[Envar 集成](docs/a2a-envar.md)说明可选的配置拉取、真实应用确认和交易观察。

## 一笔购买代表什么

一笔购买在固定服务版本下创建一个任务。查询任务不收费；等待补充信息时，只能补充原 schema 允许且不改变原需求的字段，不会创建第二笔付款。终态任务不可追加。Prompt 不能跳过金额、收款方与预算检查。

MVP 按新任务预先收款。付款成功、任务完成与交付验收是不同事实，不代表托管或自动退款。订阅、计量、里程碑、成果收费和企业账期后续单独实施。

## 发布与验证

0.2 源码主线替代此前 Python/MCP 产品入口。SDK 模拟测试、真实 Agent 调用、真实链或 PSP 付款、生产 UI 验收分别记录；合并 PR 不等于已经发布或真实付款成功。npm/容器版本以对应发布记录为准。

MPP 真实收款需要合格 Stripe 商户、获准的买方付款方式及必要验证；测试环境与真实资金必须明确区分。Envar 不持有签名密钥，也不会把未经核验的上报显示为已独立确认到账。

已有实验性交易仍应使用原版本、账本与授权恢复，不要把未知的旧 MCP/托管交易改成新 A2A 购买。[运行与恢复](docs/a2a-runtime-recovery.md)说明新运行时的重启和未知状态处理。
