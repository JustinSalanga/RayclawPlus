export interface AppStatus {
  ready: boolean;
  error: string | null;
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
