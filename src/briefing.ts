/**
 * Briefings — collects data from pollers, beads, and DB, then formats
 * structured prompts for PA to post to #briefing.
 *
 * Morning briefing: overnight summary, blockers, decisions needed.
 * Evening briefing: what shipped today, what's in progress, overnight priorities.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { getSilentAgents } from './agent-liveness.js';
import { getStaleBlockers } from './blocker-tracker.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

import type { AgentMailPoller } from './agent-mail-poller.js';
import type { EmailPoller } from './email-poller.js';

export type BriefingType = 'morning' | 'evening';

export interface BriefingData {
  type: BriefingType;
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
  recentlyClosedBeads: Array<{
    id: string;
    title: string;
    closedAt: string;
    closeReason: string;
  }>;
  inProgressBeads: Array<{
    id: string;
    title: string;
    assignee: string;
    priority: number;
  }>;
  readyBeads: Array<{
    id: string;
    title: string;
    assignee: string;
    priority: number;
  }>;
  pendingDecisions: Array<{
    id: string;
    title: string;
    assignee: string;
    priority: number;
    description: string;
  }>;
  recentCommits: string[];
  humanStatus: {
    status: string;
    since: string;
    returnNote: string;
  } | null;
  generatedAt: string;
}

/**
 * Run bd CLI and parse JSON output. Returns empty array on failure.
 */
function runBd(args: string): unknown[] {
  try {
    const output = execSync(`/usr/local/bin/bd ${args} --json`, {
      timeout: 10_000,
      encoding: 'utf-8',
      cwd: '/srv/gluon/dev',
      env: { ...process.env, HOME: '/home/ubuntu' },
    });
    return JSON.parse(output.trim());
  } catch (err) {
    logger.warn({ err, args }, 'Briefing: failed to run bd');
    return [];
  }
}

/**
 * Get recent git commits (last 12h for morning, last 8h for evening).
 */
function getRecentCommits(hours: number): string[] {
  try {
    const output = execSync(
      `git log --oneline --since="${hours} hours ago" --no-merges 2>/dev/null | head -20`,
      {
        timeout: 5_000,
        encoding: 'utf-8',
        cwd: '/srv/gluon/dev',
      },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function collectBriefingData(
  emailPoller: EmailPoller | null,
  agentMailPoller: AgentMailPoller | null,
  type: BriefingType = 'morning',
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

  // Beads: recently closed (last 24h for morning, last 12h for evening)
  const closedHours = type === 'morning' ? 24 : 12;
  const cutoff = new Date(now - closedHours * 60 * 60 * 1000).toISOString();
  const allClosed = runBd('list --status closed') as Array<{
    id: string;
    title: string;
    closed_at?: string;
    close_reason?: string;
  }>;
  const recentlyClosedBeads = allClosed
    .filter((b) => b.closed_at && b.closed_at > cutoff)
    .sort((a, b) => (b.closed_at || '').localeCompare(a.closed_at || ''))
    .slice(0, 15)
    .map((b) => ({
      id: b.id,
      title: b.title,
      closedAt: b.closed_at || '',
      closeReason: (b.close_reason || '').slice(0, 120),
    }));

  // Beads: in progress
  const inProgressBeads = (
    runBd('list --status in_progress') as Array<{
      id: string;
      title: string;
      assignee?: string;
      priority?: number;
    }>
  )
    .slice(0, 15)
    .map((b) => ({
      id: b.id,
      title: b.title,
      assignee: b.assignee || 'unassigned',
      priority: b.priority ?? 3,
    }));

  // Beads: ready (dispatch queue)
  const readyBeads = (
    runBd('ready') as Array<{
      id: string;
      title: string;
      assignee?: string;
      priority?: number;
    }>
  )
    .slice(0, 10)
    .map((b) => ({
      id: b.id,
      title: b.title,
      assignee: b.assignee || 'unassigned',
      priority: b.priority ?? 3,
    }));

  // Pending decisions (beads waiting for human input)
  const allOpen = runBd('list --status open') as Array<{
    id: string;
    title: string;
    assignee?: string;
    priority?: number;
    labels?: string[];
    description?: string;
  }>;
  const pendingDecisions = allOpen
    .filter((b) => (b.labels || []).includes('dispatch:waiting-human'))
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3))
    .slice(0, 10)
    .map((b) => ({
      id: b.id,
      title: b.title,
      assignee: b.assignee || 'unassigned',
      priority: b.priority ?? 3,
      description: (b.description || '').slice(0, 200),
    }));

  // Recent commits
  const commitHours = type === 'morning' ? 12 : 8;
  const recentCommits = getRecentCommits(commitHours);

  // Human status
  let humanStatus: BriefingData['humanStatus'] = null;
  try {
    const raw = fs.readFileSync('/srv/gluon/.human-status', 'utf-8');
    const parsed = JSON.parse(raw);
    humanStatus = {
      status: parsed.status || 'unknown',
      since: parsed.since || '',
      returnNote: parsed.return_note || '',
    };
  } catch {
    // file missing or unparseable
  }

  return {
    type,
    unresolvedBlockers,
    silentAgents,
    pollerStatuses,
    recentlyClosedBeads,
    inProgressBeads,
    readyBeads,
    pendingDecisions,
    recentCommits,
    humanStatus,
    generatedAt: new Date().toISOString(),
  };
}

export function writeBriefingPayload(groupFolder: string, data: BriefingData): string {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  fs.mkdirSync(inputDir, { recursive: true });

  const filename = `briefing-${data.type}-${Date.now()}.json`;
  const filepath = path.join(inputDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));

  logger.info({ filepath, type: data.type }, 'Briefing payload written');
  return filepath;
}

export function formatBriefingPrompt(data: BriefingData, briefingChannelId?: string): string {
  const sections: string[] = [];

  const isMorning = data.type === 'morning';
  const tag = isMorning ? '[Morning Briefing]' : '[Evening Briefing]';
  sections.push(tag);
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

  // What shipped
  if (data.recentlyClosedBeads.length > 0) {
    const label = isMorning ? 'Shipped Overnight' : 'Shipped Today';
    sections.push(`\n## ${label}`);
    for (const b of data.recentlyClosedBeads) {
      sections.push(`- **${b.id}**: ${b.title}`);
      if (b.closeReason) sections.push(`  _${b.closeReason}_`);
    }
  }

  // In progress
  if (data.inProgressBeads.length > 0) {
    sections.push('\n## In Progress');
    for (const b of data.inProgressBeads) {
      sections.push(`- **${b.id}** (P${b.priority}, ${b.assignee}): ${b.title}`);
    }
  }

  // Ready queue (morning only — so human can adjust priorities)
  if (isMorning && data.readyBeads.length > 0) {
    sections.push('\n## Ready Queue (next up)');
    for (const b of data.readyBeads.slice(0, 8)) {
      sections.push(`- **${b.id}** (P${b.priority}, ${b.assignee}): ${b.title}`);
    }
  }

  // Pending decisions (needs human input)
  if (data.pendingDecisions.length > 0) {
    sections.push('\n## ⚠️ Decisions Needed');
    for (const d of data.pendingDecisions) {
      sections.push(`- **${d.id}** (P${d.priority}): ${d.title}`);
      if (d.description) sections.push(`  _${d.description}_`);
    }
    sections.push('  _Reply with bead ID + decision to approve/adjust._');
  }

  // Recent commits
  if (data.recentCommits.length > 0) {
    const label = isMorning ? 'Commits (last 12h)' : 'Commits (today)';
    sections.push(`\n## ${label}`);
    for (const c of data.recentCommits.slice(0, 10)) {
      sections.push(`- \`${c}\``);
    }
    if (data.recentCommits.length > 10) {
      sections.push(`- ... and ${data.recentCommits.length - 10} more`);
    }
  }

  // Silent agents
  if (data.silentAgents.length > 0) {
    sections.push('\n## Silent Agents (>6h)');
    for (const a of data.silentAgents) {
      sections.push(`- ${a.name} (last: ${a.lastSeen}${a.lastSubject ? `, re: ${a.lastSubject}` : ''})`);
    }
  }

  // Human status
  if (data.humanStatus) {
    const icon = data.humanStatus.status === 'available' ? '🟢' : '🔴';
    sections.push(`\n## Human Status: ${icon} ${data.humanStatus.status}`);
    if (data.humanStatus.returnNote) {
      sections.push(`  _${data.humanStatus.returnNote}_`);
    }
  }

  // Infrastructure
  sections.push('\n## Infrastructure');
  const am = data.pollerStatuses.agentMail;
  sections.push(`- Agent Mail: ${am ? am.status : 'not configured'}`);
  const em = data.pollerStatuses.email;
  sections.push(`- Email (IMAP): ${em ? em.status : 'not configured'}`);

  // Instructions for PA
  sections.push('\n---');
  const target = briefingChannelId
    ? `Post the briefing to channel ID "${briefingChannelId}" (not the current channel) using the Slack MCP send_message tool.`
    : 'Post the briefing to #briefing using the Slack MCP send_message tool.';

  if (isMorning) {
    sections.push(`${target} Format as a concise morning summary. Highlight: blockers needing attention, what shipped overnight, what's next in the queue, and any decisions needed. Keep it short — bullet points, no fluff. If there are queued-while-away items in pa-state.md, surface those too.`);
  } else {
    sections.push(`${target} Format as a concise end-of-day summary. Highlight: what shipped today, what's still in progress, any new blockers, and overnight priorities. Keep it short — bullet points, no fluff.`);
  }

  return sections.join('\n');
}
