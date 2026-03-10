# RayClaw

RayClaw is a Rust multi-channel agent runtime. It connects Telegram, Discord, Slack, Feishu/Lark, and the built-in Web UI to one shared agent engine, one persistence layer, and one tool registry.

## Current shape

- Rust 2021, Tokio, SQLite (`rusqlite` bundled, WAL mode)
- LLM abstraction in `src/llm.rs` with native Anthropic support plus OpenAI-compatible providers
- Runtime assembly in `src/runtime.rs`
- Shared agent loop in `src/agent_engine.rs`
- Channel adapters under `src/channels/`
- Built-in tool implementations under `src/tools/`
- Embedded Web UI under `web/`

## Important source files

| File | Purpose |
|------|---------|
| `src/main.rs` | CLI entry: `start`, `setup`, `doctor`, `gateway`, `update`, `version` |
| `src/runtime.rs` | Builds `AppState`, registers channels, starts schedulers and adapters |
| `src/agent_engine.rs` | Main agent loop, prompt construction, session resume, compaction, event streaming |
| `src/llm.rs` | Provider creation and response translation |
| `src/db.rs` | SQLite schema, migrations, chats/messages/sessions/tasks/memories/usage |
| `src/memory.rs` | File-backed memory and `SOUL.md` loading |
| `src/scheduler.rs` | Scheduled tasks plus memory reflector background loops |
| `src/skills.rs` | Skill discovery, filtering, activation |
| `src/mcp.rs` | MCP server integration and dynamic tool import |
| `src/acp.rs` | ACP session management for external coding agents |
| `src/tools/mod.rs` | `Tool` trait, `ToolRegistry`, auth context, risk levels |

## Built-in tools

Generated source of truth:

```sh
node scripts/generate_docs_artifacts.mjs
```

Current built-in tool families:

- Shell and files: `bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`
- Browser and desktop: `browser`, `capture_screenshot`, `list_windows`, `focus_window`, `click`, `type_text`, `press_key`, `scroll`, `find_text`
- Web: `web_search`, `web_fetch`
- Memory: `read_memory`, `write_memory`, `structured_memory_search`, `structured_memory_update`, `structured_memory_delete`
- Planning and delegation: `todo_read`, `todo_write`, `sub_agent`
- Messaging and scheduling: `send_message`, `export_chat`, `schedule_task`, `list_scheduled_tasks`, `pause_scheduled_task`, `resume_scheduled_task`, `cancel_scheduled_task`, `get_task_history`
- Skills and ACP: `activate_skill`, `sync_skills`, `acp_new_session`, `acp_prompt`, `acp_end_session`, `acp_list_sessions`

Notes:

- `browser` wraps `agent-browser` and keeps browser state per chat.
- `capture_screenshot` is cross-platform.
- Desktop control tools in `src/tools/desktop.rs` are currently Windows-only.
- MCP tools are added dynamically at runtime after config load.

## Agent loop

`process_with_agent` in `src/agent_engine.rs` does the core work:

1. Load or rebuild the chat session.
2. Inject `SOUL.md`, file memory, structured memory, and skill catalog into the system prompt.
3. Compact old context when the session exceeds configured thresholds.
4. Call the LLM with tool schemas.
5. Execute tool calls through `ToolRegistry`.
6. Persist the updated session and final response.

Special fast paths:

- explicit `remember ...` commands can write structured memory directly
- ACP chat commands (`#new`, `#end`, `#agents`, `#sessions`) are intercepted before normal LLM execution

## Conventions

- Add new tools in all applicable registries: full runtime, SDK, and sub-agent if appropriate.
- Keep docs in sync with `docs/generated/tools.md`.
- Prefer updating generated docs artifacts when the tool surface changes.
- `SOUL.md` is the current personality file; older references to `CLAUDE.md` are stale.

## Useful commands

```sh
cargo run -- setup
cargo run -- doctor
cargo run -- start
cargo test
node scripts/generate_docs_artifacts.mjs --check
```
