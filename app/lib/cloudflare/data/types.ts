export type ChatRow = {
  id: string;
  creator_id: string;
  initial_id: string;
  description: string | null;
  timestamp: string;
  last_subchat_index: number;
  has_messages: number;
  is_deleted: number;
};

export type ChatTranscriptRow = {
  chat_id: string;
  subchat_index: number;
  agent_name: string;
  description: string | null;
  parent_subchat_index: number | null;
  parent_revision: number | null;
  transition_token: string;
  created_at: number;
  updated_at: number;
};
