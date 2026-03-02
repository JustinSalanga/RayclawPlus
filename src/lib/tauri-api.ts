import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppStatus, ConfigDto, ChatSummary, StoredMessage, AgentStreamEvent, ChannelStatus, SkillDto, SkillDetailDto } from "../types";

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

export interface Attachment {
  data: string;       // base64-encoded (no data URI prefix)
  media_type: string; // e.g. "image/png"
  name: string;
}

export async function sendMessage(chatId: number, content: string, attachments?: Attachment[]): Promise<void> {
  return invoke("send_message", {
    chatId,
    content,
    attachments: attachments && attachments.length > 0 ? attachments : null,
  });
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

export async function renameChat(chatId: number, title: string): Promise<void> {
  return invoke("rename_chat", { chatId, title });
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

// Skills
export async function listSkills(): Promise<SkillDto[]> {
  return invoke("list_skills");
}

export async function getSkill(name: string): Promise<SkillDetailDto> {
  return invoke("get_skill", { name });
}

export async function saveSkill(
  name: string,
  description: string,
  platforms: string[],
  deps: string[],
  content: string,
): Promise<void> {
  return invoke("save_skill", { name, description, platforms, deps, content });
}

export async function deleteSkill(name: string): Promise<void> {
  return invoke("delete_skill", { name });
}
