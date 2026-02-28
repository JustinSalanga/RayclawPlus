import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppStatus, ChatSummary, StoredMessage, AgentStreamEvent } from "../types";

export async function getStatus(): Promise<AppStatus> {
  return invoke("get_status");
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

export function onAgentStream(callback: (event: AgentStreamEvent) => void): Promise<UnlistenFn> {
  return listen<AgentStreamEvent>("agent-stream", (e) => callback(e.payload));
}
