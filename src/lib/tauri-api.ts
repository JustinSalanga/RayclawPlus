import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppStatus, ConfigDto, ChatSummary, StoredMessage, AgentStreamEvent, ChannelStatus } from "../types";

export async function getStatus(): Promise<AppStatus> {
  return invoke("get_status");
}

export async function getConfig(): Promise<ConfigDto> {
  return invoke("get_config");
}

export async function saveConfig(config: ConfigDto): Promise<void> {
  return invoke("save_config", { config });
}

export async function getChannelStatus(): Promise<ChannelStatus[]> {
  return invoke("get_channel_status");
}

export async function toggleChannel(name: string, enabled: boolean): Promise<void> {
  return invoke("toggle_channel", { name, enabled });
}

export async function sendMessage(chatId: number, content: string): Promise<void> {
  return invoke("send_message", { chatId, content });
}

export async function getHistory(chatId: number, limit?: number): Promise<StoredMessage[]> {
  return invoke("get_history", { chatId, limit: limit ?? 100 });
}

export async function getChats(): Promise<ChatSummary[]> {
  return invoke("get_chats");
}

export async function resetSession(chatId: number): Promise<void> {
  return invoke("reset_session", { chatId });
}

export async function newChat(): Promise<number> {
  return invoke("new_chat");
}

export async function deleteChat(chatId: number): Promise<void> {
  return invoke("delete_chat", { chatId });
}

export async function exportChatMarkdown(chatId: number): Promise<string> {
  return invoke("export_chat_markdown", { chatId });
}

export function onAgentStream(callback: (event: AgentStreamEvent) => void): Promise<UnlistenFn> {
  return listen<AgentStreamEvent>("agent-stream", (e) => callback(e.payload));
}
