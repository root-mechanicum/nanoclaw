/**
 * Morning Briefing — collects data from pollers + DB and writes
 * a payload for the PA container to format and post to #briefing.
 */
import fs from 'fs';
import path from 'path';

import { getSilentAgents } from './agent-liveness.js';
import { getStaleBlockers } from './blocker-tracker.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

import type { AgentMailPoller } from './agent-mail-poller.js';
import type { EmailPoller } from './email-poller.js';

export interface BriefingData {
  unresolvedBlockers: Array<{
    sender: string;
    subject: string;
    ageMinutes: number;
    escalationLevel: number;
  }>;
  silentAgents: Array<{
    name: string;
    lastSeen: string;
    lastSubject: string | null;
  }>;
  pollerStatuses: {
    agentMail: { status: string; lastPollTs: string | null } | null;
    email: { status: string; lastPollTs: string | null } | null;
  };
  generatedAt: string;
}

export function collectBriefingData(
  emailPoller: EmailPoller | null,
  agentMailPoller: AgentMailPoller | null,
): BriefingData {
  const now = Date.now();

  // Unresolved blockers from DB
  const staleBlockers = getStaleBlockers();
  const unresolvedBlockers = staleBlockers.map((b) => ({
    sender: b.sender,
    subject: b.subject,
    ageMinutes: Math.round((now - new Date(b.first_posted).getTime()) / 60_000),
    escalationLevel: b.escalation_level,
  }));

  // Silent agents (>6h)
  const silent = getSilentAgents(6);
  const silentAgents = silent.map((a) => ({
    name: a.agent_name,
    lastSeen: a.last_message_ts,
    lastSubject: a.last_subject,
  }));

  // Poller statuses
  const pollerStatuses = {
    agentMail: agentMailPoller?.getStatus() ?? null,
    email: emailPoller?.getStatus() ?? null,
  };

  return {
    unresolvedBlockers,
    silentAgents,
    pollerStatuses,
    generatedAt: new Date().toISOString(),
  };
}

export function writeBriefingPayload(groupFolder: string, data: BriefingData): string {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  fs.mkdirSync(inputDir, { recursive: true });

  const filename = `briefing-${Date.now()}.json`;
  const filepath = path.join(inputDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));

  logger.info({ filepath }, 'Briefing payload written');
  return filepath;
}

export function formatBriefingPrompt(data: BriefingData): string {
  const sections: string[] = [];

  sections.push('[Morning Briefing]');
  sections.push(`Generated: ${data.generatedAt}`);

  // Blockers
  if (data.unresolvedBlockers.length > 0) {
    sections.push('\n## Unresolved Blockers');
    for (const b of data.unresolvedBlockers) {
      sections.push(`- ${b.sender}: "${b.subject}" (${b.ageMinutes} min, L${b.escalationLevel})`);
    }
  } else {
    sections.push('\n## Blockers\nNone.');
  }

  // Silent agents
  if (data.silentAgents.length > 0) {
    sections.push('\n## Silent Agents (>6h)');
    for (const a of data.silentAgents) {
      sections.push(`- ${a.name} (last: ${a.lastSeen}${a.lastSubject ? `, re: ${a.lastSubject}` : ''})`);
    }
  }

  // Infrastructure
  sections.push('\n## Infrastructure');
  const am = data.pollerStatuses.agentMail;
  sections.push(`- Agent Mail: ${am ? am.status : 'not configured'}`);
  const em = data.pollerStatuses.email;
  sections.push(`- Email (IMAP): ${em ? em.status : 'not configured'}`);

  sections.push('\n---');
  sections.push('Post a concise morning briefing to #briefing using the send_message tool. Include: blockers requiring attention, silent agents, infrastructure status, and any action items. Keep it short — bullet points, no fluff.');

  return sections.join('\n');
}
