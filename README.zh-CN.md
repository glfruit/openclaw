# 🦞 OpenClaw — 个人 AI 助手（Owned Fork）

语言：[English](README.md) · [简体中文](README.zh-CN.md)

> 本文档说明当前仓库里的 **owned OpenClaw fork**。它基于 OpenClaw，但包含我们为本地分发、验证和运行所维护的打包与文档约定。除非链接明确指向上游 OpenClaw 文档，否则本文不代表上游官方发布说明。

**OpenClaw** 是运行在自己设备上的个人 AI 助手。它通过你已经在用的聊天渠道与用户交互，并以 Gateway 作为会话、渠道、工具和事件的控制平面。

常用入口：

- 上游网站：[openclaw.ai](https://openclaw.ai)
- 上游文档：[docs.openclaw.ai](https://docs.openclaw.ai)
- 入门：[Getting started](https://docs.openclaw.ai/start/getting-started)
- 更新：[Updating](https://docs.openclaw.ai/install/updating)
- 安全：[Security](https://docs.openclaw.ai/gateway/security)
- 架构：[Architecture](https://docs.openclaw.ai/concepts/architecture)

## 为什么维护自己的版本 / Fork

我们维护 owned fork 的目标不是伪装成上游官方版本，而是为本地运行环境提供可控、可验证、可回滚的发行物。

## Owned fork 操作规范

Owned fork 工作以这些本地 runbook 为准：

- [治理规范](docs/owned/GOVERNANCE.md)：分支模型、角色合规、功能流、review/QA/ship 门禁、文档归属和破坏性 git 操作保护。
- [环境规范](docs/owned/ENVIRONMENT.md)：Node/pnpm 工作流、已安装 CLI 验证、仓库健康检查、artifact 期望，以及 git pack/delta 修复提醒。
- [交接协议](docs/owned/HANDOFF.md)：scope、files、evidence、commands、commit refs、open questions、risks、next owner；没有证据不能说 done。
- [发布 runbook](docs/owned/RELEASE.md)：从 `owned/main` 切 release branch、tarball-first 验证、build/install/restart/promotion 分离、本地分发证据、rollback 和 checksum 记录。

安全模型是 local-first：文档和打包工作不会隐式全局安装、重启 Gateway、切换生产路由、重写分支历史、修改 remotes、改变 package version 或运行时行为；除非这些动作被明确纳入 scope 并留下证据。

## 安装与快速开始

常规上游安装方式仍然是：

```bash
npm install -g openclaw@latest
# 或：pnpm add -g openclaw@latest

openclaw onboard --install-daemon
```

在 owned fork 工作时，请先确认你要使用的是本地构建出来的包还是上游发布包。文档刷新、打包验证和本地 tarball 构建本身不等于生产安装。

运行时要求：**Node 24（推荐）或 Node 22.14+**。

## 核心能力概览

- **Local-first Gateway**：管理 sessions、channels、tools、events 的本地控制平面。
- **多渠道收件箱**：支持 WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage / BlueBubbles、Microsoft Teams、Matrix、Feishu、LINE、WeChat、QQ、WebChat 等。
- **多 Agent 路由**：可将不同渠道、账号或联系人路由到隔离的 agent workspace / session。
- **语音与节点能力**：支持 Voice Wake、Talk Mode、macOS / iOS / Android companion nodes。
- **Live Canvas**：agent 驱动的可视化工作区。
- **Skills 与工具系统**：通过 skills、browser、cron、sessions、channel actions 等扩展能力。

## 安全默认值

OpenClaw 会连接真实聊天渠道，因此 inbound DM 应视为不可信输入。

- 默认建议使用 DM pairing / allowlist，而不是公开处理所有私信。
- 在对外暴露前，先阅读上游 [Security](https://docs.openclaw.ai/gateway/security)、[Sandboxing](https://docs.openclaw.ai/gateway/sandboxing) 和 [Configuration](https://docs.openclaw.ai/gateway/configuration)。
- 非 main session 可使用 sandbox policy 降低群聊或外部渠道风险。

## 从源码开发

推荐使用 `pnpm`：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw

pnpm install
pnpm openclaw setup
pnpm ui:build
pnpm gateway:watch
```

如果需要生成 `dist/` 供 Node 运行、打包或 release validation 使用：

```bash
pnpm build
pnpm ui:build
```

说明：`pnpm openclaw ...` 通过 `tsx` 直接运行 TypeScript；`pnpm build` 生成 `dist/`；`pnpm gateway:watch` 用于开发循环。

## 更多文档

- 新手：[Getting started](https://docs.openclaw.ai/start/getting-started)、[Onboarding](https://docs.openclaw.ai/start/wizard)
- 渠道：[Channels](https://docs.openclaw.ai/channels)、[Telegram](https://docs.openclaw.ai/channels/telegram)、[Discord](https://docs.openclaw.ai/channels/discord)、[Slack](https://docs.openclaw.ai/channels/slack)
- 配置与安全：[Configuration](https://docs.openclaw.ai/gateway/configuration)、[Security](https://docs.openclaw.ai/gateway/security)、[Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)
- 工具与自动化：[Tools](https://docs.openclaw.ai/tools)、[Skills](https://docs.openclaw.ai/tools/skills)、[Cron jobs](https://docs.openclaw.ai/automation/cron-jobs)
- 内部机制：[Architecture](https://docs.openclaw.ai/concepts/architecture)、[Agent](https://docs.openclaw.ai/concepts/agent)、[Session model](https://docs.openclaw.ai/concepts/session)、[Gateway protocol](https://docs.openclaw.ai/reference/rpc)

## 社区与许可

OpenClaw 使用 MIT License。贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本 owned fork 应保留上游来源与许可说明，同时清楚标注 fork-specific 内容。
