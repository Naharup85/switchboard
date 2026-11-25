import { getDb } from './db.js';

export interface ConversationDoc {
  _id?: any;
  workspace: string;
  contact: string;
  assignee?: string | null;
  status?: string;
  lastMessageAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface InboundMessageDoc {
  _id?: any;
  workspace: string;
  contact: string;
  message_id: string;
  text?: string;
  occurred_at: string | Date | number;
  createdAt?: Date;
}

export interface OutboundMessageDoc {
  _id?: any;
  client_ref: string;
  workspace: string;
  contact: string;
  text: string;
  status: string;
  attempts: number;
  lockedUntil: number;
  nextAttemptAt: number;
  pigeon_message_id?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ProcessedEventDoc {
  _id?: any;
  event_id: string;
  processed_at?: Date;
}

export interface WsEventDoc {
  _id?: any;
  workspace: string;
  seq: number;
  type: string;
  contact?: string;
  message_id?: string;
  client_ref?: string;
  status?: string;
  assignee?: string;
  text?: string;
  occurred_at?: any;
  createdAt?: Date;
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
