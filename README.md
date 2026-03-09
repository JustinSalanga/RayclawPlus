# VirusClaw Desktop

[English](README.md) | [中文](README_CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-blue?logo=tauri)](https://tauri.app)
[![VirusClaw](https://img.shields.io/crates/v/rayclaw.svg?label=rayclaw)](https://crates.io/crates/rayclaw)

VirusClaw Desktop is a native desktop client for [RayClaw](https://github.com/rayclaw/rayclaw), the multi-channel agentic AI runtime. Built with Tauri 2.x + React + TypeScript, it brings the full agent engine — tool-calling, memory, streaming — to your desktop as a lightweight native app.

## Features

- **Streaming chat** — Real-time token streaming with tool execution visualization
- **Full agent engine** — Same tool-calling loop as the server: shell, file ops, web search, memory
- **Multi-session** — Create, switch, and manage multiple chat sessions
- **Markdown rendering** — Code blocks, tables, lists, and inline formatting
- **Ink & Paper theme** — Clean, minimal design with paper-white background and forest green accents
- **Lightweight** — Tauri uses the system WebView (~15-30MB), not bundled Chromium (~200MB+)
- **Multi-LLM** — Anthropic, OpenAI-compatible, AWS Bedrock, Ollama, and more

## Screenshots

| Chat Interface | AI Provider Settings | Channel Settings |
|:-:|:-:|:-:|
| ![Chat](screenshots/chat-with-claw.png) | ![AI Provider](screenshots/settings-ai-provider.png) | ![Channel](screenshots/settings-channel-feishu.png) |

## Prerequisites

- [RayClaw](https://github.com/rayclaw/rayclaw) configured (`rayclaw.config.yaml` with LLM API key)
- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/) toolchain
- Platform dependencies:
  - **macOS**: Xcode Command Line Tools
  - **Linux**: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
  - **Windows**: WebView2 (pre-installed on Windows 10/11)

## Quick start

```bash
git clone https://github.com/rayclaw/rayclaw-desktop.git
cd rayclaw-desktop
pnpm install
pnpm tauri dev
```

## Build

```bash
pnpm tauri build    # Produces .dmg (macOS) / .deb + .AppImage (Linux) / .msi (Windows)
```

## Architecture

```
rayclaw-desktop/
├── src-tauri/              # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs         # Entry point
│   │   ├── lib.rs          # Agent init + command registration
│   │   ├── state.rs        # DesktopState (holds RayClawAgent)
│   │   └── commands.rs     # Tauri IPC commands
│   └── Cargo.toml          # Depends on rayclaw crate (no default features)
├── src/                    # React frontend
│   ├── App.tsx             # Root layout (sidebar + chat)
│   ├── App.css             # Ink & Paper theme
│   ├── components/
│   │   ├── ChatWindow.tsx  # Chat with streaming support
│   │   ├── Sidebar.tsx     # Session list
│   │   ├── MessageBubble.tsx
│   │   └── ToolStep.tsx    # Tool execution indicator
│   ├── lib/tauri-api.ts    # Tauri invoke/listen wrappers
│   └── types.ts            # TypeScript interfaces
└── package.json
```

The Rust backend initializes `RayClawAgent` from the rayclaw crate and exposes 5 Tauri commands (`send_message`, `get_history`, `get_chats`, `reset_session`, `new_chat`). Streaming works via `app.emit("agent-stream", ...)` forwarding `AgentEvent` to the React frontend in real time.

## Related projects

- [RayClaw](https://github.com/rayclaw/rayclaw) — Multi-channel agentic AI runtime (server + Rust crate)

## License

MIT
