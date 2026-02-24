/**
 * Agent Liveness Monitor
 *
 * Tracks last-seen activity for Agent Mail agents and flags
 * agents that have gone silent beyond a threshold.
 */
import { getDb } from './db.js';

interface SilentAgent {
  agent_name: string;
  last_message_ts: string;
  task_description: string | null;
  last_subject: string | null;
}

export function recordAgentActivity(name: string, ts: string, subject: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_liveness (agent_name, last_message_ts, last_subject)
    VALUES (?, ?, ?)
    ON CONFLICT(agent_name) DO UPDATE SET
      last_message_ts = excluded.last_message_ts,
      last_subject = excluded.last_subject
  `).run(name, ts, subject);
}

export function getSilentAgents(thresholdHours: number): SilentAgent[] {
  const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000).toISOString();
  const db = getDb();
  return db.prepare(`
    SELECT agent_name, last_message_ts, task_description, last_subject
    FROM agent_liveness
    WHERE last_message_ts < ?
  `).all(cutoff) as SilentAgent[];
}
