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

export type AgentStreamEvent =
  | { type: "iteration"; iteration: number }
  | { type: "tool_start"; name: string }
  | { type: "tool_result"; name: string; is_error: boolean; preview: string; duration_ms: number }
  | { type: "text_delta"; delta: string }
  | { type: "final_response"; text: string };
