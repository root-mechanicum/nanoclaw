/**
 * Magic Commands — lightweight handlers that respond directly to Slack
 * without spawning a container. Detected in processGroupMessages before
 * the message hits the agent queue.
 *
 * Commands:
 *   "status"            → system status snapshot
 *   "restart dispatch"  → sudo systemctl restart gluon-dispatch
 */
import { execSync } from 'child_process';

import { collectBriefingData } from './briefing.js';
import { logger } from './logger.js';

import type { AgentMailPoller } from './agent-mail-poller.js';
import type { EmailPoller } from './email-poller.js';
import type { NewMessage } from './types.js';

export interface MagicCommandContext {
  emailPoller: EmailPoller | null;
  agentMailPoller: AgentMailPoller | null;
}

export type MagicCommandResult =
  | { handled: true; response: string }
  | { handled: false };

/**
 * Check if messages contain a magic command. Returns the response text
 * if handled, or { handled: false } if the messages should proceed to
 * normal container processing.
 *
 * Only the last user message is checked (ignores older context).
 */
export function detectMagicCommand(
  messages: NewMessage[],
  ctx: MagicCommandContext,
): MagicCommandResult {
  if (messages.length === 0) return { handled: false };

  // Check the most recent message only
  const last = messages[messages.length - 1];
  const text = last.content
    .replace(/@\w+\s*/i, '') // strip @Andy prefix
    .trim()
    .toLowerCase();

  // "status" or "system status" or "briefing"
  if (/^(status|system\s*status|briefing)$/.test(text)) {
    return { handled: true, response: handleStatus(ctx) };
  }

  // "restart dispatch"
  if (/^restart\s+dispatch$/.test(text)) {
    return { handled: true, response: handleRestartDispatch() };
  }

  return { handled: false };
}

function handleStatus(ctx: MagicCommandContext): string {
  const sections: string[] = [];
  sections.push('**System Status**\n');

  // 1. Dispatch agents (call dispatch MCP or fall back to systemd)
  try {
    const resp = fetchDispatchStatus();
    if (resp) {
      sections.push('**Dispatch Agents**');
      if (resp.count === 0) {
        sections.push('No active agents.\n');
      } else {
        for (const a of resp.agents) {
          const stall = a.lastActivity_s > 180 ? ' ⚠️ STALLED' : '';
          sections.push(
            `- **${a.name}** (${a.role}) — ${a.runtime}, up ${formatDuration(a.uptime_s)}, silent ${formatDuration(a.lastActivity_s)}${stall}`,
          );
        }
        sections.push('');
      }
    }
  } catch (err) {
    sections.push('**Dispatch**: unable to reach (is it running?)\n');
  }

  // 2. Dispatch systemd status
  try {
    const active = execSync('systemctl is-active gluon-dispatch 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    sections.push(`**Dispatch Service**: ${active}`);
  } catch {
    sections.push('**Dispatch Service**: inactive or unknown');
  }

  // 3. Ready beads
  try {
    const raw = execSync('/srv/gluon/tools/br ready --json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10000,
    });
    // br outputs log lines before JSON — count JSON objects
    const jsonLines = raw
      .split('\n')
      .filter((l) => l.trim().startsWith('{'));
    sections.push(`**Ready Beads**: ${jsonLines.length}`);
  } catch {
    sections.push('**Ready Beads**: unable to check');
  }

  // 4. Briefing data (blockers, silent agents, pollers)
  try {
    const data = collectBriefingData(ctx.emailPoller, ctx.agentMailPoller);

    if (data.unresolvedBlockers.length > 0) {
      sections.push(`\n**Blockers** (${data.unresolvedBlockers.length})`);
      for (const b of data.unresolvedBlockers) {
        sections.push(
          `- ${b.sender}: "${b.subject}" (${formatDuration(b.ageMinutes * 60)}, L${b.escalationLevel})`,
        );
      }
    } else {
      sections.push('\n**Blockers**: none');
    }

    if (data.silentAgents.length > 0) {
      sections.push(`\n**Silent Agents** (>6h)`);
      for (const a of data.silentAgents) {
        sections.push(`- ${a.name} (last: ${a.lastSeen})`);
      }
    }

    const am = data.pollerStatuses.agentMail;
    sections.push(
      `\n**Agent Mail**: ${am ? am.status : 'not configured'}`,
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to collect briefing data for status');
  }

  return sections.join('\n');
}

function handleRestartDispatch(): string {
  try {
    logger.info('Magic command: restarting gluon-dispatch');
    execSync('sudo systemctl restart gluon-dispatch', {
      encoding: 'utf-8',
      timeout: 15000,
    });

    // Brief pause then check status
    execSync('sleep 2', { timeout: 5000 });

    const active = execSync('systemctl is-active gluon-dispatch 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    return `Dispatch restarted. Service status: **${active}**`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to restart dispatch');
    return `Failed to restart dispatch: ${msg}`;
  }
}

interface DispatchAgent {
  name: string;
  role: string;
  runtime: string;
  uptime_s: number;
  lastActivity_s: number;
  respawnCount: number;
  reason?: string;
}

interface DispatchStatusResponse {
  agents: DispatchAgent[];
  count: number;
}

function fetchDispatchStatus(): DispatchStatusResponse | null {
  try {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'status-1',
      method: 'tools/call',
      params: { name: 'get_status', arguments: {} },
    });

    const resp = execSync(
      `curl -s -X POST http://127.0.0.1:7766 -H 'Content-Type: application/json' -d '${body.replace(/'/g, "'\\''")}'`,
      { encoding: 'utf-8', timeout: 5000 },
    );

    const parsed = JSON.parse(resp);
    const text = parsed?.result?.content?.[0]?.text;
    if (!text) return null;

    return JSON.parse(text) as DispatchStatusResponse;
  } catch {
    return null;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}
