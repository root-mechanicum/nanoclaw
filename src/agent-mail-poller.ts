/**
 * Agent Mail Injection Poller
 *
 * Polls OrangeFox's Agent Mail inbox and injects messages into an existing
 * chat JID so they appear alongside channel messages in a registered group.
 * The PA container handles outbound via Agent Mail MCP tools directly.
 *
 * Callbacks:
 * - onDown/onRecovered: Agent Mail connectivity alerts
 * - onAlert: host-level routing for [BLOCKED]/[ERROR] messages to #alerts
 * - onActivity: agent liveness tracking
 */
import { getRouterState, setRouterState } from './db.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

export interface AgentMailPollerOpts {
  apiUrl: string;
  authToken: string;
  projectKey: string;
  agentName: string;
  targetChatJid: string;
  onMessage: (chatJid: string, msg: NewMessage) => void;
  pollIntervalMs: number;
  /** Called when Agent Mail transitions to DOWN (3+ consecutive failures). */
  onDown?: () => void;
  /** Called when Agent Mail recovers from DOWN to connected. */
  onRecovered?: () => void;
  /** Called for messages with [BLOCKED] or [ERROR] tags — routed to #alerts. */
  onAlert?: (text: string) => void;
  /** Called for every incoming message — for agent liveness tracking. */
  onActivity?: (sender: string, ts: string, subject: string) => void;
}

type PollerStatus = 'connected' | 'degraded' | 'down';

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface InboxMessage {
  id: number;
  subject: string;
  from: string;
  created_ts: string;
  importance: string;
  ack_required: boolean;
  kind?: string;
  body_md?: string;
}

// Rate limiter: per-sender sliding window for #alerts
interface RateWindow {
  count: number;
  windowStart: number;
  suppressed: number;
  lastSubject: string;
}

const RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT = 3; // max messages per sender per window

// Noise squelching: batch operational messages instead of injecting each one
// Patterns that indicate operational noise (spawn/exit/crash notifications)
const NOISE_PATTERNS = [
  /^\[AGENT-EXIT\]/i,
  /^\[AGENT-SPAWN\]/i,
  /crashed.*exit/i,
  /respawn/i,
  /exited.*code/i,
  /spawn.*loop/i,
];

const NOISE_DIGEST_INTERVAL_MS = 10 * 60 * 1000; // Digest every 10 min

interface NoiseEntry {
  from: string;
  subject: string;
  body: string;
  ts: string;
}

function isNoiseMessage(subject: string, body: string | undefined): boolean {
  const text = `${subject} ${body || ''}`;
  return NOISE_PATTERNS.some(p => p.test(text));
}

export class AgentMailPoller {
  private opts: AgentMailPollerOpts;
  private interval: ReturnType<typeof setInterval> | null = null;
  private sinceTsKey = 'agent_mail_since_ts';
  private sinceTs: string;
  private consecutiveFailures = 0;
  private status: PollerStatus = 'down';
  private lastPollTs: string | null = null;
  private rpcId = 0;
  private alertRateMap = new Map<string, RateWindow>();
  private noiseBuffer: NoiseEntry[] = [];
  private noiseDigestTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AgentMailPollerOpts) {
    this.opts = opts;
    this.sinceTs = getRouterState(this.sinceTsKey) || '';
  }

  /**
   * Register the agent with Agent Mail and start the polling loop.
   */
  async start(): Promise<void> {
    // Register agent identity
    try {
      await this.rpc('tools/call', {
        name: 'register_agent',
        arguments: {
          project_key: this.opts.projectKey,
          name: this.opts.agentName,
          program: 'nanoclaw',
          model: 'claude-sonnet-4-5',
          task_description: 'NanoClaw PA injection poller',
        },
      });
      this.status = 'connected';
      this.consecutiveFailures = 0;
      logger.info(
        { agent: this.opts.agentName, project: this.opts.projectKey },
        'Agent Mail: registered as %s',
        this.opts.agentName,
      );
    } catch (err) {
      // Non-fatal: polling will retry on next tick
      logger.warn({ err }, 'Agent Mail: registration failed, will retry on poll');
      this.status = 'degraded';
    }

    // Start polling
    this.interval = setInterval(() => {
      this.poll().catch((err) => {
        logger.error({ err }, 'Agent Mail: unhandled poll error');
      });
    }, this.opts.pollIntervalMs);

    // Start noise digest timer
    this.noiseDigestTimer = setInterval(() => {
      this.flushNoiseDigest();
    }, NOISE_DIGEST_INTERVAL_MS);

    // First poll immediately
    this.poll().catch((err) => {
      logger.error({ err }, 'Agent Mail: initial poll error');
    });

    logger.info(
      { intervalMs: this.opts.pollIntervalMs, targetJid: this.opts.targetChatJid },
      'Agent Mail poller started',
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.noiseDigestTimer) {
      clearInterval(this.noiseDigestTimer);
      this.noiseDigestTimer = null;
    }
    // Flush any remaining noise on shutdown
    this.flushNoiseDigest();
    logger.info('Agent Mail poller stopped');
  }

  getStatus(): { status: PollerStatus; lastPollTs: string | null } {
    return { status: this.status, lastPollTs: this.lastPollTs };
  }

  private async poll(): Promise<void> {
    try {
      const result = await this.rpc('tools/call', {
        name: 'fetch_inbox',
        arguments: {
          project_key: this.opts.projectKey,
          agent_name: this.opts.agentName,
          include_bodies: true,
          since_ts: this.sinceTs || undefined,
          limit: 50,
        },
      });

      this.lastPollTs = new Date().toISOString();

      // Detect recovery from DOWN
      const wasDown = this.status === 'down';
      this.consecutiveFailures = 0;
      this.status = 'connected';

      if (wasDown) {
        logger.info('Agent Mail: connection restored');
        this.opts.onRecovered?.();
      }

      // The MCP response wraps results in { content: [{ text }] }
      const messages = this.parseInboxResult(result);

      if (messages.length > 0) {
        logger.info(
          { count: messages.length },
          'Agent Mail: received %d new messages',
          messages.length,
        );
      }

      for (const msg of messages) {
        // Noise squelching: buffer operational noise instead of injecting immediately
        if (isNoiseMessage(msg.subject, msg.body_md)) {
          this.noiseBuffer.push({
            from: msg.from,
            subject: msg.subject,
            body: msg.body_md || '',
            ts: msg.created_ts,
          });
          logger.debug(
            { from: msg.from, subject: msg.subject, buffered: this.noiseBuffer.length },
            'Agent Mail: noise message buffered for digest',
          );

          // Still track activity and advance cursor, just don't inject
          this.opts.onActivity?.(msg.from, msg.created_ts, msg.subject);
          this.markAndAck(msg);
          if (msg.created_ts > this.sinceTs) {
            this.sinceTs = msg.created_ts;
          }
          continue;
        }

        // Convert to NewMessage and inject into the PA group
        const newMsg: NewMessage = {
          id: `am-${msg.id}`,
          chat_jid: this.opts.targetChatJid,
          sender: `am:${msg.from}`,
          sender_name: `${msg.from} (AgentMail)`,
          content: `[AgentMail from ${msg.from}] ${msg.subject}\n\n${msg.body_md || ''}`.trim(),
          timestamp: msg.created_ts,
          is_from_me: false,
          is_bot_message: false,
        };

        this.opts.onMessage(this.opts.targetChatJid, newMsg);

        // Agent liveness tracking
        this.opts.onActivity?.(msg.from, msg.created_ts, msg.subject);

        // Route [BLOCKED]/[ERROR] messages to #alerts (rate-limited)
        this.maybeAlert(msg);

        // Mark as read + ack
        this.markAndAck(msg);

        // Advance cursor
        if (msg.created_ts > this.sinceTs) {
          this.sinceTs = msg.created_ts;
        }
      }

      // Persist cursor
      if (messages.length > 0) {
        setRouterState(this.sinceTsKey, this.sinceTs);
      }
    } catch (err) {
      this.consecutiveFailures++;
      this.lastPollTs = new Date().toISOString();

      if (this.consecutiveFailures >= 3) {
        if (this.status !== 'down') {
          logger.error(
            { failures: this.consecutiveFailures },
            'Agent Mail: 3+ consecutive failures, marking as down',
          );
          this.status = 'down';
          this.opts.onDown?.();
        }
      } else {
        this.status = 'degraded';
        logger.warn(
          { err, failures: this.consecutiveFailures },
          'Agent Mail: poll failed',
        );
      }
    }
  }

  /**
   * Mark a message as read and acknowledge if required.
   */
  private markAndAck(msg: InboxMessage): void {
    this.rpc('tools/call', {
      name: 'mark_message_read',
      arguments: {
        project_key: this.opts.projectKey,
        agent_name: this.opts.agentName,
        message_id: msg.id,
      },
    }).catch((err) =>
      logger.warn({ err, messageId: msg.id }, 'Agent Mail: failed to mark message read'),
    );

    if (msg.ack_required) {
      this.rpc('tools/call', {
        name: 'acknowledge_message',
        arguments: {
          project_key: this.opts.projectKey,
          agent_name: this.opts.agentName,
          message_id: msg.id,
        },
      }).catch((err) =>
        logger.warn({ err, messageId: msg.id }, 'Agent Mail: failed to acknowledge message'),
      );
    }
  }

  /**
   * Flush buffered noise messages as a single digest message.
   * Groups by agent and provides a summary instead of individual messages.
   */
  private flushNoiseDigest(): void {
    if (this.noiseBuffer.length === 0) return;

    const entries = this.noiseBuffer.splice(0);

    // Group by agent
    const byAgent = new Map<string, NoiseEntry[]>();
    for (const entry of entries) {
      const list = byAgent.get(entry.from) || [];
      list.push(entry);
      byAgent.set(entry.from, list);
    }

    // Build digest
    const lines: string[] = [`[Ops Digest] ${entries.length} operational events in the last ${NOISE_DIGEST_INTERVAL_MS / 60_000} min:`];
    for (const [agent, agentEntries] of byAgent) {
      if (agentEntries.length === 1) {
        lines.push(`• ${agent}: ${agentEntries[0].subject}`);
      } else {
        // Deduplicate similar subjects
        const subjectCounts = new Map<string, number>();
        for (const e of agentEntries) {
          // Normalize: strip agent names and IDs for grouping
          const normalized = e.subject.replace(/\b\w+Agent\b/g, '*').replace(/\b[a-f0-9-]{8,}\b/g, '*');
          subjectCounts.set(normalized, (subjectCounts.get(normalized) || 0) + 1);
        }
        const summaries = [...subjectCounts.entries()].map(([subj, count]) =>
          count > 1 ? `${subj} (×${count})` : subj
        );
        lines.push(`• ${agent}: ${summaries.join(', ')}`);
      }
    }

    const digestContent = lines.join('\n');

    const newMsg: NewMessage = {
      id: `am-digest-${Date.now()}`,
      chat_jid: this.opts.targetChatJid,
      sender: 'am:system',
      sender_name: 'Dispatch (digest)',
      content: digestContent,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    };

    this.opts.onMessage(this.opts.targetChatJid, newMsg);
    logger.info(
      { count: entries.length, agents: [...byAgent.keys()] },
      'Agent Mail: flushed noise digest',
    );
  }

  /**
   * Check if a message has [BLOCKED] or [ERROR] tags and route to #alerts
   * with per-sender rate limiting.
   */
  private maybeAlert(msg: InboxMessage): void {
    if (!this.opts.onAlert) return;

    const isBlocked = msg.subject.includes('[BLOCKED]');
    const isError = msg.subject.includes('[ERROR]');
    if (!isBlocked && !isError) return;

    const now = Date.now();
    let window = this.alertRateMap.get(msg.from);

    // Reset window if expired
    if (window && now - window.windowStart >= RATE_WINDOW_MS) {
      // Flush suppression summary before resetting
      if (window.suppressed > 0) {
        this.opts.onAlert(
          `${msg.from} sent ${window.count} alert messages in 5 min. Latest: ${window.lastSubject}. Suppressed ${window.suppressed}.`,
        );
      }
      window = undefined;
    }

    if (!window) {
      window = { count: 0, windowStart: now, suppressed: 0, lastSubject: msg.subject };
      this.alertRateMap.set(msg.from, window);
    }

    window.count++;
    window.lastSubject = msg.subject;

    if (window.count <= RATE_LIMIT) {
      const tag = isBlocked ? 'BLOCKED' : 'ERROR';
      this.opts.onAlert(`[${tag}] ${msg.from}: ${msg.subject}`);
    } else {
      window.suppressed++;
    }
  }

  /**
   * Parse the MCP tool call result to extract inbox messages.
   * The response is wrapped in MCP content format: { content: [{ type: "text", text: "..." }] }
   */
  private parseInboxResult(result: unknown): InboxMessage[] {
    if (!result || typeof result !== 'object') return [];

    // MCP tools/call returns { content: [{ type: "text", text: "<json>" }] }
    const r = result as { content?: Array<{ type: string; text: string }> };
    if (r.content && Array.isArray(r.content)) {
      for (const item of r.content) {
        if (item.type === 'text' && item.text) {
          try {
            const parsed = JSON.parse(item.text);
            // fetch_inbox returns an array of messages directly, or { messages: [...] }
            if (Array.isArray(parsed)) return parsed;
            if (parsed.messages && Array.isArray(parsed.messages)) return parsed.messages;
            // toon format wraps in { data: "..." }
            if (parsed.data && typeof parsed.data === 'string') {
              const inner = JSON.parse(parsed.data);
              if (Array.isArray(inner)) return inner;
            }
          } catch {
            // Not JSON, skip
          }
        }
      }
    }

    // Direct array (non-MCP wrapper)
    if (Array.isArray(result)) return result;

    return [];
  }

  /**
   * JSON-RPC 2.0 call to the Agent Mail HTTP API.
   */
  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.rpcId;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const resp = await fetch(this.opts.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.opts.authToken}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      throw new Error(`Agent Mail HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }

    const json = (await resp.json()) as JsonRpcResponse;
    if (json.error) {
      throw new Error(`Agent Mail RPC error ${json.error.code}: ${json.error.message}`);
    }

    return json.result;
  }
}
