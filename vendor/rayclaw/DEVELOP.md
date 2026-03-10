# RayClaw Developer Guide

## Quick start

```sh
git clone <repo-url>
cd rayclaw
cargo run -- setup
cargo run -- doctor
cargo run -- start
```

## Prerequisites

- Rust toolchain
- Node.js if you use browser automation or Node-based MCP/ACP tooling
- At least one enabled channel or `web_enabled: true`
- A configured LLM provider

## Current architecture

RayClaw is no longer organized around a single Telegram-centric entrypoint. The current runtime shape is:

- `src/main.rs`: CLI dispatch
- `src/runtime.rs`: channel registration, `AppState` creation, scheduler startup, graceful shutdown
- `src/agent_engine.rs`: shared agent loop and prompt assembly
- `src/channels/`: platform adapters
- `src/tools/`: built-in tool implementations
- `src/web.rs`: embedded Web UI and HTTP API

Important support modules:

- `src/db.rs`: SQLite schema and queries
- `src/memory.rs`: file memory and `SOUL.md`
- `src/memory_quality.rs`: explicit-memory parsing and quality heuristics
- `src/scheduler.rs`: scheduled tasks and memory reflector loops
- `src/skills.rs`: skill loading and activation
- `src/mcp.rs`: MCP config and runtime federation
- `src/acp.rs`: ACP subprocess sessions for external coding agents
- `src/doctor.rs`: environment diagnostics

## Tool surface

Static built-in tools are listed in `docs/generated/tools.md`.

Current families:

- shell and file tools
- browser automation
- desktop screenshots and Windows desktop control
- web retrieval
- memory and structured memory
- scheduling and messaging
- planning, skills, sub-agents, ACP

Runtime detail:

- MCP tools are added dynamically during startup from configured MCP servers.
- ACP tools are added during `create_app_state()`.

## Browser and desktop automation

Recent additions:

- `browser`: wraps `agent-browser` with per-chat browser sessions and persistent profiles
- `capture_screenshot`: captures the desktop to PNG
- desktop control tools in `src/tools/desktop.rs`:
  - `list_windows`
  - `focus_window`
  - `click`
  - `type_text`
  - `press_key`
  - `scroll`
  - `find_text`

Platform notes:

- `browser` is cross-platform when `agent-browser` is installed or bundled.
- `capture_screenshot` supports Windows, macOS, and Linux.
- `desktop.rs` tools are currently Windows-only.

## Agent flow

High-level execution path:

1. Platform adapter stores the incoming message and resolves the internal chat id.
2. `process_with_agent()` acquires a per-chat lock.
3. Explicit-memory and ACP command fast paths run before normal inference.
4. Session is loaded from SQLite or reconstructed from chat history.
5. System prompt is assembled from runtime instructions, memory, `SOUL.md`, and skills.
6. The LLM receives the tool schema set.
7. Tool calls are executed through `ToolRegistry`.
8. Updated session state and final text are persisted.

## Adding a tool

1. Create `src/tools/my_tool.rs` implementing `Tool`.
2. Export it from `src/tools/mod.rs`.
3. Register it in the appropriate registries:
   - `ToolRegistry::new`
   - `ToolRegistry::new_for_sdk` if SDK users should see it
   - `ToolRegistry::new_sub_agent` if sub-agents should see it
4. Set the correct risk in `tool_risk()` if it has side effects.
5. Add tests.
6. Regenerate docs artifacts:

```sh
node scripts/generate_docs_artifacts.mjs
```

Minimal skeleton:

```rust
use async_trait::async_trait;
use serde_json::json;

use super::{schema_object, Tool, ToolResult};
use crate::llm_types::ToolDefinition;

pub struct MyTool;

#[async_trait]
impl Tool for MyTool {
    fn name(&self) -> &str {
        "my_tool"
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: "my_tool".into(),
            description: "Describe the tool clearly.".into(),
            input_schema: schema_object(
                json!({
                    "value": {
                        "type": "string",
                        "description": "Required input"
                    }
                }),
                &["value"],
            ),
        }
    }

    async fn execute(&self, input: serde_json::Value) -> ToolResult {
        let value = match input.get("value").and_then(|v| v.as_str()) {
            Some(v) => v,
            None => return ToolResult::error("Missing 'value' parameter".into()),
        };
        ToolResult::success(format!("ok: {value}"))
    }
}
```

## Adding a platform adapter

1. Add the adapter under `src/channels/`.
2. Normalize inbound events into the canonical runtime shape:
   - caller channel
   - internal chat id
   - chat type
   - sender name
   - message content blocks
3. Reuse the shared agent engine instead of building a platform-specific loop.
4. Implement outbound delivery and message splitting rules.
5. Preserve stable chat identity across restarts.
6. Respect chat authorization and cross-chat boundaries.

## Database notes

Core persisted areas:

- chats and messages
- sessions
- scheduled tasks and task run logs
- structured memories and memory observability
- usage logs

Channel identity is channel-scoped; do not assume a raw external id is globally unique.

## Docs and drift checks

Regenerate generated docs:

```sh
node scripts/generate_docs_artifacts.mjs
```

Check for drift:

```sh
node scripts/generate_docs_artifacts.mjs --check
```

## Useful commands

```sh
cargo build
cargo test
RUST_LOG=debug cargo run -- start
sqlite3 rayclaw.data/runtime/rayclaw.db
```
