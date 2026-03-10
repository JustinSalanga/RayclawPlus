# AGENTS.md

## Project overview

RayClaw is a Rust multi-channel agent runtime. Telegram, Discord, Slack, Feishu/Lark, and the built-in Web UI all feed the same agent loop, database, memory system, and tool registry.

Core capabilities:

- multi-step tool-calling agent loop with session persistence
- context compaction for long-running chats
- scheduled tasks and background execution
- file memory plus structured memory
- skills, MCP federation, and ACP external-agent control
- browser automation and desktop automation tools

## Tech stack

- Rust 2021
- Tokio
- SQLite via `rusqlite` with WAL mode
- `reqwest` for provider and web calls
- native Anthropic support plus OpenAI-compatible providers
- `axum` for the embedded Web UI/API

## Source layout

- `src/main.rs`: CLI entrypoint
- `src/runtime.rs`: builds `AppState`, registers channels, starts background tasks
- `src/agent_engine.rs`: shared agent loop, prompt assembly, session resume, compaction
- `src/llm.rs`: provider abstraction and streaming
- `src/db.rs`: persistence and migrations
- `src/memory.rs`: file memory and `SOUL.md`
- `src/scheduler.rs`: scheduled task runner and memory reflector
- `src/skills.rs`: skill discovery and activation
- `src/mcp.rs`: MCP server integration
- `src/acp.rs`: ACP lifecycle and session routing
- `src/channels/`: Telegram, Discord, Slack, Feishu, delivery helpers
- `src/tools/`: built-in tools and registry

## Tool system

`src/tools/mod.rs` defines:

- `Tool`: `name()`, `definition()`, `execute()`
- `ToolRegistry`: built-in tool registration, auth injection, high-risk approval gate
- `ToolRisk`: low / medium / high

Built-in tool groups:

- shell and files: `bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`
- browser and desktop: `browser`, `capture_screenshot`, `list_windows`, `focus_window`, `click`, `type_text`, `press_key`, `scroll`, `find_text`
- web: `web_search`, `web_fetch`
- memory: `read_memory`, `write_memory`, `structured_memory_search`, `structured_memory_update`, `structured_memory_delete`
- messaging and scheduling: `send_message`, `export_chat`, `schedule_task`, `list_scheduled_tasks`, `pause_scheduled_task`, `resume_scheduled_task`, `cancel_scheduled_task`, `get_task_history`
- planning and delegation: `todo_read`, `todo_write`, `sub_agent`
- skills and ACP: `activate_skill`, `sync_skills`, `acp_new_session`, `acp_prompt`, `acp_end_session`, `acp_list_sessions`

Notes:

- `browser` depends on `agent-browser`.
- `capture_screenshot` works cross-platform.
- desktop control tools from `src/tools/desktop.rs` are Windows-only.
- MCP tools are injected dynamically after config load and are not part of the static built-in count.

Regenerate docs artifacts with:

```sh
node scripts/generate_docs_artifacts.mjs
```

## Agent loop

`process_with_agent` flow:

1. Handle explicit-memory fast path and ACP command routing when applicable.
2. Load resumable session or reconstruct from chat history.
3. Build the system prompt from identity, memory, skills, and runtime instructions.
4. Compact old context when needed.
5. Call the LLM with tool schemas.
6. Execute tool calls and append results until end-turn or iteration limit.
7. Persist updated session state and final response.

## Memory

Two layers:

1. File memory
   - global: `runtime/groups/AGENTS.md`
   - per-chat: `runtime/groups/{chat_id}/AGENTS.md`
2. Structured memory
   - SQLite `memories` table
   - quality gates, dedup, supersede edges, optional embeddings

Personality is loaded from `SOUL.md`, not `CLAUDE.md`.

## Docs hygiene

- If you change tools, update the generated docs artifacts and any user-facing docs that summarize tool families.
- If you add a new tool, consider all registries: full runtime, SDK, and sub-agent.
- If you add a platform-specific capability, document the platform constraint explicitly.
