/**
 * Blocker Escalation Tracker
 *
 * Tracks [BLOCKED] messages from Agent Mail and escalates reminders
 * at increasing intervals if they remain unresolved.
 */
import { getDb } from './db.js';
import { logger } from './logger.js';

interface StaleBlocker {
  agent_mail_id: number;
  sender: string;
  subject: string;
  first_posted: string;
  last_escalated: string;
  escalation_level: number;
}

// Escalation thresholds (minutes since first_posted)
const ESCALATION_THRESHOLDS: Record<number, number> = {
  0: 30,     // Level 0 → 1: 30 min
  1: 120,    // Level 1 → 2: 2 hours
  2: 480,    // Level 2 → 3: 8 hours
};

export function trackBlocker(id: number, sender: string, subject: string): void {
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO blocker_escalation (agent_mail_id, sender, subject, first_posted, last_escalated)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, sender, subject, now, now);
}

export function resolveBlocker(id: number): void {
  const db = getDb();
  db.prepare(`UPDATE blocker_escalation SET resolved = 1 WHERE agent_mail_id = ?`).run(id);
}

export function getStaleBlockers(): StaleBlocker[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT agent_mail_id, sender, subject, first_posted, last_escalated, escalation_level
    FROM blocker_escalation
    WHERE resolved = 0 AND escalation_level < 3
  `).all() as StaleBlocker[];

  return rows.filter((row) => {
    const threshold = ESCALATION_THRESHOLDS[row.escalation_level];
    if (threshold === undefined) return false;
    const age = (now - new Date(row.first_posted).getTime()) / 60_000;
    return age >= threshold;
  });
}

export function escalateBlocker(id: number, newLevel: number): void {
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`
    UPDATE blocker_escalation SET last_escalated = ?, escalation_level = ? WHERE agent_mail_id = ?
  `).run(now, newLevel, id);
  logger.info({ blockerId: id, level: newLevel }, 'Blocker escalated');
}
