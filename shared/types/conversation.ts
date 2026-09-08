import type { Content, RunInput } from './domain';

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  run_id: string;
  role: 'user' | 'assistant';
  revision_id: string;
  block_id: string;
  created_at: number;
  content: Content;
  references: Pick<RunInput, 'label' | 'revision_id'>[];
}
