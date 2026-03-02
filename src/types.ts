export interface AppStatus {
  ready: boolean;
  error: string | null;
}

export interface ConfigDto {
  llm_provider: string;
  api_key: string;
  model: string;
  llm_base_url: string | null;
  max_tokens: number;
  show_thinking: boolean;
  // AWS Bedrock
  aws_region: string | null;
  aws_access_key_id: string | null;
  aws_secret_access_key: string | null;
  aws_profile: string | null;
  // Session
  max_tool_iterations: number;
  max_history_messages: number;
  max_session_messages: number;
  // Paths
  data_dir: string;
  working_dir: string;
  timezone: string;
  // Advanced
  skip_tool_approval: boolean;
  soul_path: string | null;
  memory_token_budget: number;
  reflector_enabled: boolean;
  // Channels — Telegram
  telegram_bot_token: string;
  bot_username: string;
  // Channels — Discord
  discord_bot_token: string | null;
  // Channels — Slack
  slack_bot_token: string | null;
  slack_app_token: string | null;
  // Channels — Feishu
  feishu_app_id: string | null;
  feishu_app_secret: string | null;
  // Channels — Web
  web_enabled: boolean;
}

export interface ChatSummary {
  chat_id: number;
  chat_title: string | null;
  chat_type: string;
  last_message_time: string;
  last_message_preview: string | null;
}

export interface StoredMessage {
  id: string;
  chat_id: number;
  sender_name: string;
  content: string;
  is_from_bot: boolean;
  timestamp: string;
}

export interface ChannelStatus {
  name: string;
  configured: boolean;
  enabled: boolean;
  running: boolean;
}

export function inferChannel(chatType: string): string {
  switch (chatType) {
    case "private":
    case "group":
    case "supergroup":
    case "channel":
      return "telegram";
    case "discord":
      return "discord";
    case "slack":
    case "slack_dm":
      return "slack";
    case "feishu_dm":
    case "feishu_group":
      return "feishu";
    case "web":
      return "web";
    case "desktop":
      return "desktop";
    default:
      return "unknown";
  }
}

export function channelLabel(chatType: string): string | null {
  const ch = inferChannel(chatType);
  switch (ch) {
    case "telegram":
      return "TG";
    case "discord":
      return "DC";
    case "slack":
      return "Slack";
    case "feishu":
      return "Feishu";
    case "web":
      return "Web";
    default:
      return null;
  }
}

export type AgentStreamEvent =
  | { type: "iteration"; chat_id: number; iteration: number }
  | { type: "tool_start"; chat_id: number; name: string }
  | { type: "tool_result"; chat_id: number; name: string; is_error: boolean; preview: string; duration_ms: number }
  | { type: "text_delta"; chat_id: number; delta: string }
  | { type: "final_response"; chat_id: number; text: string }
  | { type: "error"; chat_id: number; message: string };
