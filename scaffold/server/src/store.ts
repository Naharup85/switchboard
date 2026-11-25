import { getDb } from './db.js';

export interface ConversationDoc {
  workspace: string;
  contact: string;
  assignee?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface InboundMessageDoc {
  workspace: string;
  contact: string;
  message_id: string;
  text?: string;
  occurred_at: string | Date | number;
  createdAt?: Date;
}

export interface OutboundMessageDoc {
  client_ref: string;
  workspace: string;
  contact: string;
  text: string;
  status: string;
  attempts: number;
  lockedUntil: number;
  nextAttemptAt: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ProcessedEventDoc {
  event_id: string;
  processed_at?: Date;
}

export interface WsEventDoc {
  workspace: string;
  seq: number;
  [key: string]: any;
}

export async function ensureIndexes(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.collection('conversations').createIndex({ workspace: 1, contact: 1 }, { unique: true }),
    db.collection('inbound_messages').createIndex({ workspace: 1, message_id: 1 }, { unique: true }),
    db.collection('outbound_messages').createIndex({ client_ref: 1 }, { unique: true }),
    db.collection('processed_events').createIndex({ event_id: 1 }, { unique: true }),
    db.collection('ws_events').createIndex({ workspace: 1, seq: 1 }, { unique: true }),
  ]);
}
