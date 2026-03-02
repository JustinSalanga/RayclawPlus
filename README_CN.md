# RayClaw Desktop

[English](README.md) | [中文](README_CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-blue?logo=tauri)](https://tauri.app)
[![RayClaw](https://img.shields.io/crates/v/rayclaw.svg?label=rayclaw)](https://crates.io/crates/rayclaw)

RayClaw Desktop 是 [RayClaw](https://github.com/rayclaw/rayclaw) 多频道 AI Agent 运行时的原生桌面客户端。基于 Tauri 2.x + React + TypeScript 构建，将 RayClaw 完整的 Agent 引擎 — 工具调用、记忆系统、流式输出 — 以轻量原生应用的形式带到桌面。

## 功能特性

- **流式聊天** — 实时 token 流式输出，工具执行步骤可视化
- **完整 Agent 引擎** — 与服务端一致的工具调用循环：Shell 命令、文件操作、网页搜索、记忆系统
- **多会话管理** — 创建、切换、管理多个聊天会话
- **Markdown 渲染** — 代码块、表格、列表、行内格式
- **Ink & Paper 主题** — 简洁设计，纸白底色 + 森林绿点缀
- **轻量级** — Tauri 使用系统 WebView（~15-30MB），而非打包 Chromium（~200MB+）
- **多模型支持** — Anthropic、OpenAI 兼容接口、AWS Bedrock、Ollama 等

## 截图

| 聊天界面 | AI 模型设置 | 频道设置 |
|:-:|:-:|:-:|
| ![聊天](screenshots/chat-with-claw.png) | ![AI 模型](screenshots/settings-ai-provider.png) | ![频道](screenshots/settings-channel-feishu.png) |

## 前置条件

- [RayClaw](https://github.com/rayclaw/rayclaw) 已配置（`rayclaw.config.yaml` 含 LLM API key）
- [Node.js](https://nodejs.org/) 18+ 和 [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/) 工具链
- 平台依赖：
  - **macOS**：Xcode 命令行工具
  - **Linux**：`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
  - **Windows**：WebView2（Windows 10/11 已预装）

## 快速开始

```bash
git clone https://github.com/rayclaw/rayclaw-desktop.git
cd rayclaw-desktop
pnpm install
pnpm tauri dev
```

## 构建

```bash
pnpm tauri build    # 生成 .dmg (macOS) / .deb + .AppImage (Linux) / .msi (Windows)
```

## 架构

```
rayclaw-desktop/
├── src-tauri/              # Rust 后端（Tauri）
│   ├── src/
│   │   ├── main.rs         # 入口
│   │   ├── lib.rs          # Agent 初始化 + 命令注册
│   │   ├── state.rs        # DesktopState（持有 RayClawAgent）
│   │   └── commands.rs     # Tauri IPC 命令
│   └── Cargo.toml          # 依赖 rayclaw crate（无默认 features）
├── src/                    # React 前端
│   ├── App.tsx             # 根布局（侧边栏 + 聊天）
│   ├── App.css             # Ink & Paper 主题
│   ├── components/
│   │   ├── ChatWindow.tsx  # 聊天窗口（支持流式输出）
│   │   ├── Sidebar.tsx     # 会话列表
│   │   ├── MessageBubble.tsx
│   │   └── ToolStep.tsx    # 工具执行指示器
│   ├── lib/tauri-api.ts    # Tauri invoke/listen 封装
│   └── types.ts            # TypeScript 类型定义
└── package.json
```

Rust 后端从 rayclaw crate 初始化 `RayClawAgent`，暴露 5 个 Tauri 命令（`send_message`、`get_history`、`get_chats`、`reset_session`、`new_chat`）。流式输出通过 `app.emit("agent-stream", ...)` 将 `AgentEvent` 实时转发到 React 前端。

## 相关项目

- [RayClaw](https://github.com/rayclaw/rayclaw) — 多频道 AI Agent 运行时（服务端 + Rust crate）

## 许可证

MIT
