# EnvarPay 分发与多语言接入方案

2026-10-01 进度更新：Python `envarpay==0.1.0a6` 已正式发布 PyPI，并核对 CI/索引文件哈希与干净安装。
npm 名称确定为 **`@envarai/envarpay`**，组织 owner 已核对。
`packages/typescript` 已实现认证钱包 MCP 客户端候选；发布仍待候选 PR 和首次认证。
下方保留最初调研记录，早期的 registry 404 和“TS 未实现”只描述当时状态。

核对时间：2026-09-30。这是分发与接入设计，不是“已经发布”的公告。

## 结论

采用 **一个可独立部署的支付服务 + Python/TypeScript 开发接口 + 必要的原生插件**。
不要因为 Agent 用 Rust、Python 或 TypeScript 实现，就复制一套该语言的签名、预算和恢复状态机。
也不要把“npm 包在安装时调用 pip、偷偷装 Python”当成原生 TypeScript SDK。

MCP 规定 stdio 和 Streamable HTTP 消息传输，并不要求客户端和服务端语言相同。
**运行一个支付组件**与**把 SDK 嵌入自己的程序**需要不同的安装方式：前者适合 CLI/容器，后者才需要语言对应的库。

## 已核实的现状

- PyPI `envarpay`：索引返回 404；npm `envarpay`：索引返回 404。404 不代表已取得该名称的发布所有权。
- GitHub 有 `v0.1.0a1`、`v0.1.0a3` 预发布；本候选为 `0.1.0a6`，已纳入 main 的 `0.1.0a5` HTTP/原操作恢复安全修复。GitHub Release、PyPI 和 npm 是不同渠道。
- 仓库没有 npm `package.json`、TypeScript 源码包或已实现的 OpenClaw/OpenCode 原生插件，不能写 `npm install envarpay` 当作现有功能。
- 当前核心是 Python SDK/CLI，使用 x402 Python 2.24.0、MCP 1.28.1，已有独立钱包服务、收费门禁和本地账本。
- 历史跨框架实付矩阵为 28/30；配置、安装、发布和只读 RPC 检查不增加实付通过数。

## 按生态选择接口

| 生态 | 官方接入机制 | 建议默认路径 | 何时需要对应语言包 |
|---|---|---|---|
| OpenClaw | 原生 MCP；插件支持 npm/JS/TS | MCP 接独立钱包，收费入口接既有能力服务 | 需要原生配置向导、命令或工具 UI 时做薄的 npm 插件 |
| Hermes | Python Agent；原生 MCP 支持本地/远端服务 | Python CLI 或容器 + MCP；模型留在 Hermes | 需要 Python API 编程调用时用 PyPI SDK；不必改 Hermes 核心 |
| OpenCode | 原生 MCP；JS/TS 插件支持 npm，由 Bun 加载 | 先用 MCP 配置 | 需要 hooks、自定义工具/会话集成时做 npm 插件 |
| Goose | Rust runtime；官方扩展教程直接使用 Python MCP server | MCP 扩展，CLI 或远端服务 | 默认不需要 Rust crate；只有真正嵌入 Rust 应用时再评估 |
| LangChain/LangGraph Python | Python MCP 适配器 | PyPI SDK 或独立钱包 MCP | Python library；注意 MCP major 版本的环境隔离 |
| LangChain/LangGraph JS | npm 的 `@langchain/mcp-adapters` | 官方 TS MCP client 或后续 EnvarPay TS SDK | 这是 npm SDK 的明确应用场景 |
| Pydantic AI | Python `MCPToolset` | PyPI SDK 或独立钱包 MCP | Python library；宿主和钱包依赖不强塞进同一环境 |

实际原生插件需要自己的 manifest、入口、权限与版本兼容验证。普通 npm SDK 不能冒充 OpenClaw 插件；“支持 MCP”也不能冒充某个版本已实付验收。

## 建议的分发物

### 1. PyPI：`envarpay`

当前已经存在、最应该优先完成公开分发的 SDK + CLI。

- 日常用户：发布后用 `uv tool install envarpay==0.1.0a6` 或 `pipx install envarpay==0.1.0a6`，持久、隔离地安装 CLI。
- Python 开发者：在自己的受控环境中 `pip install envarpay==0.1.0a6`，使用 Python API；框架有不同 MCP major 时接独立钱包。
- `uvx` 适合试用命令。当前生成的 host-config 使用绝对解释器路径，不能把临时 uvx 缓存路径当成长久安装位置。
- PyPI 使用独立、无 Mermaid/相对图片的长描述，避免 GitHub README 搬到 PyPI 后再次出现坏图。
- OIDC Trusted Publishing，构建一次、检验 wheel/sdist，再上传同一份 artifact；不在仓库放长期 PyPI token。

### 2. OCI 容器：建议 `ghcr.io/envarai/envarpay`

提供只有支付服务依赖的镜像，包含 CLI、钱包服务和收费门禁，**不包含 Hermes/OpenClaw/LLM runtime**。

- 这是 Node、Rust 等宿主不想安装 Python 时的默认接入路径。
- 钱包用认证的私有 MCP endpoint，只有钱包容器挂载签名密钥、策略和账本；Agent 只拿私有连接凭据。
- 收费门禁只需要收款地址和私有上游；外部入口用 HTTPS。
- 提供 amd64/arm64 镜像与不可变 digest，验证非 root、持久状态、重启恢复与授权边界。
- 新 Dockerfile/CI build 不等于镜像已经进入 GHCR；实际匿名 pull 验证完成后才能展示可用的 `docker pull` 命令。

### 3. npm：`@envarai/envarpay`

先实现真正的 TypeScript client SDK，而不是 Python 安装器外壳。

第一阶段 API 对接已有认证钱包 MCP 服务：typed discovery、callPaidTool、paymentStatus、recoverPayment、typed errors；不把私钥交给 Agent，不允许模型更改预算。
使用官方 `@modelcontextprotocol/sdk`，保持 MCP wire format。它是**远端钱包客户端 SDK**，应明确不提供进程内托管/结算服务。

仅当真实需求要求完全不运行服务时，再评估基于官方 `@x402/core`、`@x402/mcp`、`@x402/evm` 的原生 TS signer/server。此时必须完成与 Python 相同的状态机、预算、nonce、恢复、链上证明和跨语言实付验收，不能只复制几个 sign/fetch 调用。

已核实 npm 的官方 MCP SDK 为 1.31.0、`@x402/core`/`@x402/mcp` 为 2.27.0；Python x402 为 2.24.0。
SDK 包版本无需相等，协议契约和行为必须交叉验证。这里的版本是调研快照，不是未经测试的升级指令。

### 4. 原生插件：按需要增加

后续可增加 OpenClaw/OpenCode npm 插件，复用 TypeScript client。Hermes/Goose 的原生 MCP 配置先保持足够简单，不为凑数量发布空包。
同一仓库可保留现有 Python `src/envarpay`，增加 `packages/typescript`，再按真实需要增加 `integrations/openclaw` 等；不需要现在搬动整个 Python 项目。

### 5. 安装发现元数据：MCP Registry

在包/镜像真正可下载后，可增加 [官方 MCP Registry](https://github.com/modelcontextprotocol/registry) 的 server 元数据，供兼容客户端发现安装方式。Registry 会验证发布 namespace 的所有权；它不是 npm/PyPI 的替代品，也不是 Agent 交易、信誉或付款协议。本轮不创建未验证的 registry listing。

## 执行顺序与验收

1. 修复 README 图，改为仓库内 SVG；保留图源；实际渲染检查。
2. 准备并审查 PyPI 分发物、独立镜像、版本匹配和 OIDC 发布流程。当前没有 npm SDK，不先发空 npm 包。
3. 由 PyPI 项目 owner 配置 Trusted Publisher；明确批准目标版本后发布。随后从干净机器按索引安装、核对实际版本与命令。
4. 发布经过测试的 OCI image，并从未登录环境验证公开拉取。发布前不要把 GHCR 地址当成现有安装渠道。
5. 实现 TS client；从 `npm pack` 的 tarball 安装到新的 JS/TS 项目，验证类型导出、Node/Bun、MCP 认证、错误与恢复语义；再发布 npm。
6. 跨语言实付要独立记录真实交易与交付。成功安装、模型 Run、CI、离线签名都不能替代付款证据。

任何发布都不隐含主网付款、启用生产开关、替钱包持有人签名或升级既有钱包预算。

## 官方来源

- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)：标准进程边界与传输。
- [OpenClaw MCP](https://github.com/openclaw/openclaw/blob/e47d0ce424bcb800dec2112ec57192026724eea0/docs/tools/mcp.md)、[plugins](https://github.com/openclaw/openclaw/blob/e47d0ce424bcb800dec2112ec57192026724eea0/docs/cli/plugins.md)。
- [Hermes MCP](https://github.com/NousResearch/hermes-agent/blob/ca705dbf7ef86425b381b542712aff310f1ee52c/website/docs/user-guide/features/mcp.md)。
- [OpenCode plugins](https://github.com/anomalyco/opencode/blob/7945de208964a49300d7f770d1a71d078db9a4c4/packages/web/src/content/docs/plugins.mdx)。
- [Goose extension tutorial](https://github.com/aaif-goose/goose/blob/b92a80daf4a77d7e854709965bdfdc489c0472d2/documentation/docs/tutorials/custom-extensions.md)：Rust 宿主使用 Python MCP 扩展的直接例子。
- [LangChain JS MCP package](https://www.npmjs.com/package/@langchain/mcp-adapters)。
- [Pydantic AI MCP](https://github.com/pydantic/pydantic-ai/blob/ec0b1067bb29a80527a7cfbd72ee3d9fca656986/docs/mcp/client.md)。
- [x402 SDKs](https://github.com/x402-foundation/x402)。
- [uv persistent tools](https://docs.astral.sh/uv/guides/tools/)。
- [PyPI Trusted Publishers](https://docs.pypi.org/trusted-publishers/)、[npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)：npm 要求 CLI >=11.5.1、Node >=22.14.0，并对支持的 CI runner 有要求。
