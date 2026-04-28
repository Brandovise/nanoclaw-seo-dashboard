/**
 * v2 session message aggregation (read-only), aligned with reference messages-data.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';

export type DashboardMessageRow = {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
  chat_name: string;
  channel: string;
};

type SessionFeedRow = {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  messaging_group_name: string | null;
  agent_name: string | null;
};

function parseMessageContent(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.markdown === 'string') return parsed.markdown;
    return raw;
  } catch {
    return raw;
  }
}

function parseInboundIdentity(raw: unknown): { sender: string; senderName: string } {
  if (typeof raw !== 'string') return { sender: 'unknown', senderName: 'unknown' };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sender =
      (typeof parsed.sender === 'string' && parsed.sender) ||
      (typeof parsed.senderId === 'string' && parsed.senderId) ||
      'unknown';
    const senderName =
      (typeof parsed.senderName === 'string' && parsed.senderName) ||
      (typeof parsed.sender_name === 'string' && parsed.sender_name) ||
      sender;
    return { sender, senderName };
  } catch {
    return { sender: 'unknown', senderName: 'unknown' };
  }
}

export function collectV2Messages(cfg: AppConfig, db: Database.Database): DashboardMessageRow[] {
  const sessions = db
    .prepare(
      `SELECT s.id, s.agent_group_id, s.messaging_group_id, s.thread_id,
              mg.platform_id, mg.channel_type, mg.name as messaging_group_name,
              ag.name as agent_name
         FROM sessions s
         LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
         LEFT JOIN agent_groups ag ON ag.id = s.agent_group_id`,
    )
    .all() as SessionFeedRow[];

  const rows: DashboardMessageRow[] = [];
  for (const session of sessions) {
    const baseDir = path.join(cfg.v2SessionsDir, session.agent_group_id, session.id);
    const inboundPath = path.join(baseDir, 'inbound.db');
    const outboundPath = path.join(baseDir, 'outbound.db');

    if (fs.existsSync(inboundPath)) {
      try {
        const inboundDb = new Database(inboundPath, { readonly: true });
        const inboundRows = inboundDb
          .prepare(
            `SELECT id, timestamp, platform_id, channel_type, content FROM messages_in ORDER BY seq DESC LIMIT 500`,
          )
          .all() as Array<{
            id: string;
            timestamp: string;
            platform_id: string | null;
            channel_type: string | null;
            content: string;
          }>;
        inboundDb.close();
        for (const msg of inboundRows) {
          const ids = parseInboundIdentity(msg.content);
          rows.push({
            id: msg.id,
            chat_jid: msg.platform_id || session.platform_id || session.messaging_group_id || 'unknown',
            sender: ids.sender,
            sender_name: ids.senderName,
            content: parseMessageContent(msg.content),
            timestamp: msg.timestamp,
            is_from_me: 0,
            is_bot_message: 0,
            chat_name: session.messaging_group_name || msg.platform_id || 'unknown',
            channel: msg.channel_type || session.channel_type || 'unknown',
          });
        }
      } catch {
        /* skip */
      }
    }

    if (fs.existsSync(outboundPath)) {
      try {
        const outboundDb = new Database(outboundPath, { readonly: true });
        const outboundRows = outboundDb
          .prepare(
            `SELECT id, timestamp, platform_id, channel_type, content FROM messages_out ORDER BY seq DESC LIMIT 500`,
          )
          .all() as Array<{
            id: string;
            timestamp: string;
            platform_id: string | null;
            channel_type: string | null;
            content: string;
          }>;
        outboundDb.close();
        for (const msg of outboundRows) {
          rows.push({
            id: msg.id,
            chat_jid: msg.platform_id || session.platform_id || session.messaging_group_id || 'unknown',
            sender: 'assistant',
            sender_name: session.agent_name || 'assistant',
            content: parseMessageContent(msg.content),
            timestamp: msg.timestamp,
            is_from_me: 1,
            is_bot_message: 1,
            chat_name: session.messaging_group_name || 'unknown',
            channel: msg.channel_type || session.channel_type || 'unknown',
          });
        }
      } catch {
        /* skip */
      }
    }
  }
  return rows;
}
