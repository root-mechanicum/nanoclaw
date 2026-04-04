import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  AGENT_MAIL_API_URL,
  AGENT_MAIL_AUTH_TOKEN,
  AGENT_MAIL_AGENT_NAME,
  AGENT_MAIL_POLL_INTERVAL,
  AGENT_MAIL_PROJECT_KEY,
  AGENT_MAIL_TARGET_JID,
  ASSISTANT_NAME,
  DATA_DIR,
  HEALTHCHECK_PING_URL,
  IDLE_TIMEOUT,
  MAIL_FROM_ADDRESS,
  MAIL_FROM_NAME,
  MAIL_IMAP_HOST,
  MAIL_IMAP_PASS,
  MAIL_IMAP_PORT,
  MAIL_IMAP_USER,
  MAIL_POLL_INTERVAL,
  MAIL_SMTP_HOST,
  MAIL_SMTP_PASS,
  MAIL_SMTP_PORT,
  MAIL_SMTP_USER,
  MAIL_TARGET_JID,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  SLACK_ALERTS_CHANNEL,
  SLACK_APP_TOKEN,
  SLACK_BLOCKERS_CHANNEL,
  SLACK_EMAILS_CHANNEL,
  SLACK_BOT_TOKEN,
  SLACK_BRIEFING_CHANNEL,
  SLACK_ONLY,
  TAILSCALE_IP,
  TRIGGER_PATTERN,
  WEBHOOK_PORT,
} from './config.js';
import { AgentMailPoller } from './agent-mail-poller.js';
import { recordAgentActivity, getSilentAgents } from './agent-liveness.js';
import { postAlert } from './alerts.js';
import { trackBlocker, getStaleBlockers, escalateBlocker, setBlockerSlackTs, resolveBlocker, clearResolvedBlocker } from './blocker-tracker.js';
import { EmailPoller } from './email-poller.js';
import { EmailSender } from './email-sender.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { SlackChannel } from './channels/slack.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeFleetSnapshot,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { runHostAgent } from './host-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  createTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  deleteSession,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { detectMagicCommand } from './magic-commands.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel | null = null;
let agentMailPoller: AgentMailPoller | null = null;
let emailPoller: EmailPoller | null = null;
let emailSender: EmailSender | null = null;
const channels: Channel[] = [];
const queue = new GroupQueue();
const stickyProviderByChat = new Map<string, 'claude' | 'codex'>();

interface ExecutionProfile {
  providerHint: 'claude' | 'codex';
  modelHint: string;
  reason: string;
}

function chooseExecutionProfile(chatJid: string, messages: NewMessage[]): ExecutionProfile {
  const defaultProvider =
    (process.env.PA_PROVIDER_DEFAULT || 'codex').toLowerCase() === 'claude'
      ? 'claude'
      : 'codex';
  const stickyEnabled =
    !/^(0|false|no)$/i.test((process.env.PA_PROVIDER_STICKY || 'true').trim());
  const cheapModel = process.env.PA_CHEAP_MODEL || process.env.NANOCLAW_MODEL || 'claude-sonnet-4-5';
  const heavyModel = process.env.PA_HEAVY_MODEL || cheapModel;

  const text = messages
    .map((m) => `${m.sender_name || ''} ${m.content || ''}`.toLowerCase())
    .join('\n');

  const hasCodexOverride = /\[(use-codex|provider:codex)\]/i.test(text);
  const hasClaudeOverride = /\[(use-claude|provider:claude)\]/i.test(text);
  const needsHeavyReasoning =
    /\b(strategy|governance|constitutional|tradeoff|architecture|discuss|long-form|briefing)\b/i.test(text);
  const urgentOrBlocked = /\[(blocked|error|urgent)\]/i.test(text);

  let provider: 'claude' | 'codex' = defaultProvider;
  let reason = 'default';

  if (hasClaudeOverride) {
    provider = 'claude';
    reason = 'explicit_claude_override';
  } else if (hasCodexOverride) {
    provider = 'codex';
    reason = 'explicit_codex_override';
  } else if (needsHeavyReasoning || urgentOrBlocked) {
    provider = 'claude';
    reason = needsHeavyReasoning ? 'complex_reasoning' : 'urgent_or_blocked';
  } else if (stickyEnabled) {
    const sticky = stickyProviderByChat.get(chatJid);
    if (sticky) {
      provider = sticky;
      reason = 'sticky';
    }
  }

  if (stickyEnabled) {
    stickyProviderByChat.set(chatJid, provider);
  }

  // Codex adapter is not wired into NanoClaw yet; keep explicit provider choice
  // for audit, but execute with a cheap Claude model for now.
  const modelHint = provider === 'claude' ? heavyModel : cheapModel;
  return { providerHint: provider, modelHint, reason };
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Apply agent name to main group — enables --agent mode (skill loading) instead of --append-system-prompt.
  const paAgentName = process.env.PA_AGENT_NAME || '';
  if (paAgentName) {
    for (const [jid, group] of Object.entries(registeredGroups)) {
      if (group.folder === MAIN_GROUP_FOLDER) {
        group.agentName = paAgentName;
        logger.info({ jid, agentName: paAgentName }, 'PA agent name set');
      }
    }
  }

  // Register additional host-mode groups from HOST_GROUPS env var.
  // Format: JSON array of {jid, name, folder, agentName?, hostCwd?}
  // Example: HOST_GROUPS='[{"jid":"sl:C123","name":"#meta","folder":"meta","agentName":"meta-agent"}]'
  const hostGroupsEnv = process.env.HOST_GROUPS || '';
  if (hostGroupsEnv) {
    try {
      const hostGroups = JSON.parse(hostGroupsEnv) as Array<{
        jid: string;
        name: string;
        folder: string;
        agentName?: string;
        hostCwd?: string;
        requiresTrigger?: boolean;
      }>;
      for (const hg of hostGroups) {
        if (!registeredGroups[hg.jid]) {
          const group: RegisteredGroup = {
            name: hg.name,
            folder: hg.folder,
            trigger: `@${ASSISTANT_NAME}`,
            added_at: new Date().toISOString(),
            requiresTrigger: hg.requiresTrigger ?? false,
            agentName: hg.agentName,
            hostMode: true,
            hostCwd: hg.hostCwd,
          };
          registerGroup(hg.jid, group);
          logger.info({ jid: hg.jid, folder: hg.folder, agentName: hg.agentName }, 'Host group registered from HOST_GROUPS env');
        } else {
          // Update existing group with host mode settings
          const existing = registeredGroups[hg.jid];
          existing.hostMode = true;
          if (hg.agentName) existing.agentName = hg.agentName;
          if (hg.hostCwd) existing.hostCwd = hg.hostCwd;
          if (hg.requiresTrigger !== undefined) existing.requiresTrigger = hg.requiresTrigger;
          setRegisteredGroup(hg.jid, existing);
          logger.info({ jid: hg.jid, folder: hg.folder }, 'Host group updated from HOST_GROUPS env');
        }
      }
    } catch (err) {
      logger.error({ err, raw: hostGroupsEnv }, 'Failed to parse HOST_GROUPS env var');
    }
  }

  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  let missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // Cap message batch size to prevent prompt overflow that crashes the host agent.
  // When messages pile up (e.g. after a service restart with stale cursor), sending
  // hundreds of messages as a single prompt causes claude -p to exit immediately.
  // Keep the most recent messages and advance the cursor past skipped ones.
  const MAX_MESSAGE_BATCH = 50;
  if (missedMessages.length > MAX_MESSAGE_BATCH) {
    const skipped = missedMessages.length - MAX_MESSAGE_BATCH;
    logger.warn(
      { group: group.name, total: missedMessages.length, skipped, kept: MAX_MESSAGE_BATCH },
      'Message backlog exceeds batch limit, skipping older messages',
    );
    // Advance cursor past skipped messages so they won't be retried
    const skippedMessages = missedMessages.slice(0, skipped);
    lastAgentTimestamp[chatJid] = skippedMessages[skippedMessages.length - 1].timestamp;
    saveState();
    // Only process the most recent messages
    missedMessages = missedMessages.slice(skipped);
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // Magic commands: respond directly without spawning a container
  const magic = detectMagicCommand(missedMessages, {
    emailPoller,
    agentMailPoller,
  });
  if (magic.handled) {
    logger.info({ group: group.name }, `Magic command handled`);
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    await channel.sendMessage(chatJid, magic.response);
    return true;
  }

  const prompt = formatMessages(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const executionProfile = chooseExecutionProfile(chatJid, missedMessages);
  logger.info(
    {
      group: group.name,
      chatJid,
      providerHint: executionProfile.providerHint,
      modelHint: executionProfile.modelHint,
      providerReason: executionProfile.reason,
    },
    'Execution profile selected',
  );

  const output = await runAgent(group, prompt, chatJid, executionProfile, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);

      // Detect auth failure in streaming output — kill the container immediately
      // so it doesn't keep looping with an expired token via IPC
      const isAuthFailure =
        raw.includes('authentication_error') ||
        raw.includes('OAuth token has expired');
      if (isAuthFailure) {
        logger.warn(
          { group: group.name },
          'Auth failure detected in streaming output, killing container to force fresh token on next spawn',
        );
        queue.closeStdin(chatJid);
        hadError = true;
        return;
      }

      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Check if retries are about to be exhausted — if so, DON'T roll back
    // the cursor. This prevents a poisoned message batch (e.g. 950+ messages)
    // from being retried indefinitely across service restarts.
    const retryCount = queue.getRetryCount(chatJid);
    if (retryCount >= 4) { // MAX_RETRIES is 5, this is the last attempt
      logger.error(
        { group: group.name, retryCount },
        'Retries nearly exhausted, advancing cursor to prevent infinite retry loop',
      );
      // Cursor stays advanced — these messages are dropped
      return false;
    }

    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  executionProfile: ExecutionProfile,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const paCheapNoResume =
    isMain && /^(1|true|yes)$/i.test((process.env.PA_CHEAP_NO_RESUME || '').trim());
  const sessionId = paCheapNoResume ? undefined : sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Write fleet state snapshot from bd agent beads (PA only)
  writeFleetSnapshot(group.folder, isMain);

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId && !paCheapNoResume) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Use host runner when: (a) PA main group with PA_HOST_MODE=1, or (b) group.hostMode is true.
  // Host mode gives agents direct access to bd, Agent Mail, and all host tools.
  const useHostRunner =
    (isMain && /^(1|true|yes)$/i.test((process.env.PA_HOST_MODE || '').trim())) ||
    !!group.hostMode;
  if (useHostRunner) {
    logger.info({ group: group.name, hostMode: group.hostMode, isMain }, 'Using host runner');
  }

  try {
    const runnerInput = {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
      providerHint: executionProfile.providerHint,
      modelHint: executionProfile.modelHint,
      providerReason: executionProfile.reason,
    };

    const onProcessRegistered = (proc: import('child_process').ChildProcess, name: string) =>
      queue.registerProcess(chatJid, proc, name, group.folder);

    const output = useHostRunner
      ? await runHostAgent(group, runnerInput, onProcessRegistered, wrappedOnOutput)
      : await runContainerAgent(group, runnerInput, onProcessRegistered, wrappedOnOutput);

    if (output.newSessionId && !paCheapNoResume) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    // Detect AUP refusal — the session is now poisoned and must be reset
    const aupPoisoned =
      (output.result?.includes('violate our Usage Policy') ||
        output.error?.includes('violate our Usage Policy'));

    // Detect auth failure — session stuck after rate limit (Claude Code bug)
    const authPoisoned =
      (output.result?.includes('authentication_error') ||
        output.error?.includes('authentication_error') ||
        output.result?.includes('OAuth token has expired') ||
        output.error?.includes('OAuth token has expired'));

    // Detect stale session — claude -p --resume fails when session expired or was
    // cleaned up (e.g. after RuntimeMaxSec restart). Without this, each retry gets
    // a new session_id from the error response, saves it, and the next retry also
    // fails → infinite retry loop burning 1000+ attempts/day.
    const sessionNotFound =
      (output.result?.includes('No conversation found with session ID') ||
        output.error?.includes('No conversation found with session ID'));

    if ((aupPoisoned || authPoisoned || sessionNotFound) && output.newSessionId) {
      const reason = aupPoisoned ? 'aup' : authPoisoned ? 'auth' : 'session-not-found';
      logger.warn(
        { group: group.name, sessionId: output.newSessionId, reason },
        `${reason === 'aup' ? 'AUP refusal' : reason === 'auth' ? 'Auth failure' : 'Stale session'} detected, clearing poisoned session`,
      );
      delete sessions[group.folder];
      deleteSession(group.folder);
      // Remove the session file so the next invocation starts fresh
      const sessionFile = path.join(
        DATA_DIR, 'sessions', group.folder, '.claude', 'projects',
        '-workspace-group', `${output.newSessionId}.jsonl`,
      );
      try { fs.unlinkSync(sessionFile); } catch { /* already gone */ }
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.isActive(chatJid)) {
            if (queue.sendMessage(chatJid, formatted)) {
              logger.debug(
                { chatJid, count: messagesToSend.length },
                'Piped messages to active container',
              );
              lastAgentTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              saveState();
              channel.setTyping?.(chatJid, true)?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
            }
          } else {
            // No active container — enqueue for a new one (includes emails)
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    agentMailPoller?.stop();
    emailPoller?.stop();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
    const slack = new SlackChannel(SLACK_BOT_TOKEN, SLACK_APP_TOKEN, channelOpts);
    channels.push(slack);
    await slack.connect();
  }

  if (!SLACK_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  // Helper: send a message to #alerts via the Slack channel
  const slackChannel = channels.find((c) => c.name === 'slack') ?? null;
  const sendToAlerts = (text: string): void => {
    if (!slackChannel || !SLACK_ALERTS_CHANNEL) return;
    slackChannel.sendMessage(`sl:${SLACK_ALERTS_CHANNEL}`, text).catch((err) =>
      logger.warn({ err }, 'Failed to send to #alerts'),
    );
  };

  // Helper: send a message to #blockers via Slack API directly (returns message ts for later deletion)
  const sendToBlockers = async (text: string): Promise<string | null> => {
    if (!SLACK_BOT_TOKEN || !SLACK_BLOCKERS_CHANNEL) return null;
    try {
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel: SLACK_BLOCKERS_CHANNEL, text }),
        signal: AbortSignal.timeout(5_000),
      });
      const data = await resp.json() as { ok: boolean; ts?: string };
      if (data.ok && data.ts) return data.ts;
      logger.warn({ data }, 'Slack postMessage to #blockers returned non-ok');
      return null;
    } catch (err) {
      logger.warn({ err }, 'Failed to send to #blockers');
      return null;
    }
  };

  // Helper: delete a message from #blockers by ts
  const deleteFromBlockers = async (ts: string): Promise<void> => {
    if (!SLACK_BOT_TOKEN || !SLACK_BLOCKERS_CHANNEL) return;
    try {
      await fetch(`https://slack.com/api/chat.delete`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel: SLACK_BLOCKERS_CHANNEL, ts }),
        signal: AbortSignal.timeout(5_000),
      });
      logger.info({ ts }, 'Deleted resolved blocker from #blockers');
    } catch (err) {
      logger.warn({ err, ts }, 'Failed to delete blocker from #blockers');
    }
  };

  // Helper: post to #emails channel (raw email visibility for human)
  const sendToEmails = async (from: string, to: string, subject: string, body: string): Promise<void> => {
    if (!SLACK_BOT_TOKEN || !SLACK_EMAILS_CHANNEL) {
      logger.info({ hasBotToken: !!SLACK_BOT_TOKEN, channel: SLACK_EMAILS_CHANNEL }, 'sendToEmails: skipped (missing config)');
      return;
    }
    const preview = body.length > 500 ? body.slice(0, 500) + '...' : body;
    const text = `*From:* ${from}\n*To:* ${to}\n*Subject:* ${subject}\n\n${preview}`;
    try {
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel: SLACK_EMAILS_CHANNEL, text }),
        signal: AbortSignal.timeout(5_000),
      });
      const data = await resp.json() as { ok: boolean; error?: string };
      if (data.ok) {
        logger.info({ from, subject }, 'Email posted to #emails');
      } else {
        logger.warn({ error: data.error, channel: SLACK_EMAILS_CHANNEL }, 'Slack rejected #emails post');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to send to #emails');
    }
  };

  // Agent Mail injection poller (not a channel — injects into existing JID)
  if (AGENT_MAIL_API_URL && AGENT_MAIL_AUTH_TOKEN) {
    agentMailPoller = new AgentMailPoller({
      apiUrl: AGENT_MAIL_API_URL,
      authToken: AGENT_MAIL_AUTH_TOKEN,
      projectKey: AGENT_MAIL_PROJECT_KEY,
      agentName: AGENT_MAIL_AGENT_NAME,
      targetChatJid: AGENT_MAIL_TARGET_JID,
      onMessage: (_chatJid, msg) => storeMessage(msg),
      pollIntervalMs: AGENT_MAIL_POLL_INTERVAL,
      onDown: () => postAlert('Agent Mail is unreachable. Agent coordination is offline.'),
      onRecovered: () => postAlert('Agent Mail connection restored.'),
      onAlert: (text) => {
        sendToAlerts(text);
        // Track [BLOCKED] messages for escalation → post to #blockers
        const blockedMatch = text.match(/^\[BLOCKED\] (.+?): (.+)$/);
        if (blockedMatch) {
          const idMatch = text.match(/am-(\d+)/);
          const blockerId = idMatch ? parseInt(idMatch[1], 10) : null;
          if (blockerId) trackBlocker(blockerId, blockedMatch[1], blockedMatch[2]);
          sendToBlockers(text).then((slackTs) => {
            if (slackTs && blockerId) setBlockerSlackTs(blockerId, slackTs);
          });
        } else if (/\[(?:UNBLOCKED|RESOLVED)\]/i.test(text)) {
          // Resolve tracked blockers and delete from #blockers
          const resolvedIdMatch = text.match(/am-(\d+)/);
          if (resolvedIdMatch) {
            const resolved = resolveBlocker(parseInt(resolvedIdMatch[1], 10));
            if (resolved?.slack_ts) {
              deleteFromBlockers(resolved.slack_ts).then(() =>
                clearResolvedBlocker(resolved.agent_mail_id),
              );
            }
          }
        } else if (/\b(BLOCKED|ESCALAT|urgent|blocker)\b/i.test(text)) {
          // Urgent messages without structured [BLOCKED] format
          sendToBlockers(text);
        }
      },
      onActivity: (sender, ts, subject) => recordAgentActivity(sender, ts, subject),
    });
    await agentMailPoller.start();
  }

  // Email (IMAP) poller — injects into the same PA channel
  if (MAIL_IMAP_HOST && MAIL_IMAP_USER && MAIL_IMAP_PASS) {
    emailPoller = new EmailPoller({
      imapHost: MAIL_IMAP_HOST,
      imapPort: MAIL_IMAP_PORT,
      imapUser: MAIL_IMAP_USER,
      imapPass: MAIL_IMAP_PASS,
      targetChatJid: MAIL_TARGET_JID,
      onMessage: (_chatJid, msg) => storeMessage(msg),
      onEmail: (email) => sendToEmails(
        `${email.from} <${email.fromAddress}>`, email.to, email.subject, email.body,
      ),
      pollIntervalMs: MAIL_POLL_INTERVAL,
      onDown: () => postAlert('Email (IMAP) is unreachable. Inbound email processing is offline.'),
      onRecovered: () => postAlert('Email (IMAP) connection restored.'),
    });
    await emailPoller.start();

    // Write email snapshot to main group's IPC dir for container MCP tools
    const emailSnapshotPath = path.join(DATA_DIR, 'ipc', MAIN_GROUP_FOLDER, 'email_inbox.json');
    const writeEmailSnapshot = () => {
      try {
        emailPoller!.writeSnapshot(emailSnapshotPath);
      } catch (err) {
        logger.warn({ err }, 'Failed to write email snapshot');
      }
    };
    // Seed cache with recent emails on startup (reads all recent, not just unseen)
    emailPoller.fetchRecent(100).then(() => {
      writeEmailSnapshot();
      logger.info('Email cache seeded on startup');
    }).catch((err) => logger.warn({ err }, 'Failed to seed email cache'));
    // Write after each poll cycle (match poll interval)
    setInterval(writeEmailSnapshot, MAIL_POLL_INTERVAL);
  }

  // Email (SMTP) sender
  if (MAIL_SMTP_HOST && MAIL_SMTP_USER && MAIL_SMTP_PASS && MAIL_FROM_ADDRESS) {
    emailSender = new EmailSender({
      smtpHost: MAIL_SMTP_HOST,
      smtpPort: MAIL_SMTP_PORT,
      smtpUser: MAIL_SMTP_USER,
      smtpPass: MAIL_SMTP_PASS,
      fromAddress: MAIL_FROM_ADDRESS,
      fromName: MAIL_FROM_NAME,
    });
    emailSender.verify().catch(() => {});
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    emailPoller,
    agentMailPoller,
    briefingChannelId: SLACK_BRIEFING_CHANNEL || undefined,
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    sendEmail: emailSender
      ? (args) => emailSender!.send(args)
      : undefined,
    fetchEmails: emailPoller
      ? async () => {
          const snapshotPath = path.join(DATA_DIR, 'ipc', MAIN_GROUP_FOLDER, 'email_inbox.json');
          await emailPoller!.fetchRecent();
          emailPoller!.writeSnapshot(snapshotPath);
        }
      : undefined,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Health endpoint — used by external monitors (UptimeRobot, gluon cron)
  startHealthServer();

  // Dead man's switch — ping external monitor every 5 minutes
  if (HEALTHCHECK_PING_URL) {
    const pingHealthcheck = () => {
      fetch(HEALTHCHECK_PING_URL).catch(() => {});
    };
    pingHealthcheck(); // Ping immediately on startup
    setInterval(pingHealthcheck, 5 * 60 * 1000);
    logger.info('Healthcheck heartbeat enabled');
  }

  // Blocker re-escalation — check every 10 minutes for stale [BLOCKED] messages
  setInterval(() => {
    try {
      const stale = getStaleBlockers();
      for (const blocker of stale) {
        const newLevel = blocker.escalation_level + 1;
        const age = Math.round((Date.now() - new Date(blocker.first_posted).getTime()) / 60_000);
        const msg = `Reminder (L${newLevel}): [BLOCKED] from ${blocker.sender} — "${blocker.subject}" — unresolved for ${age} min`;
        sendToBlockers(msg);
        sendToAlerts(msg);

        // At L2+, also email PA's own inbox for out-of-band visibility
        if (newLevel >= 2 && emailSender && MAIL_FROM_ADDRESS) {
          emailSender.send({
            to: MAIL_FROM_ADDRESS,
            subject: `[BLOCKED L${newLevel}] ${blocker.subject}`,
            body: msg,
          }).catch((err) => logger.warn({ err }, 'Failed to send blocker escalation email'));
        }

        escalateBlocker(blocker.agent_mail_id, newLevel);
      }
    } catch (err) {
      logger.error({ err }, 'Blocker escalation check failed');
    }
  }, 10 * 60 * 1000);

  // Agent liveness monitor — check every 60 minutes for silent agents
  setInterval(() => {
    try {
      const silent = getSilentAgents(6);
      if (silent.length > 0) {
        const summary = silent
          .map((a) => `${a.agent_name} (last seen: ${a.last_message_ts}${a.last_subject ? `, re: ${a.last_subject}` : ''})`)
          .join('\n');
        sendToAlerts(`Silent agents (>6h):\n${summary}`);
      }
    } catch (err) {
      logger.error({ err }, 'Agent liveness check failed');
    }
  }, 60 * 60 * 1000);

  // Auto-register morning briefing task if SLACK_BRIEFING_CHANNEL is set
  if (SLACK_BRIEFING_CHANNEL) {
    const tasks = getAllTasks();
    const hasBriefing = tasks.some((t) => t.prompt.includes('[Morning Briefing]') && t.status === 'active');
    if (!hasBriefing) {
      // Find the PA group JID
      const paJid = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      )?.[0];
      if (paJid) {
        const taskId = `briefing-${Date.now()}`;
        createTask({
          id: taskId,
          group_folder: MAIN_GROUP_FOLDER,
          chat_jid: paJid,
          prompt: '[Morning Briefing] Collect system status and post a morning briefing to #briefing.',
          schedule_type: 'cron',
          schedule_value: '0 8 * * 1-5',
          context_mode: 'isolated',
          next_run: null, // Will be computed on first scheduler tick
          status: 'active',
          created_at: new Date().toISOString(),
        });
        // Compute next_run immediately
        const { CronExpressionParser } = await import('cron-parser');
        const { TIMEZONE } = await import('./config.js');
        try {
          const interval = CronExpressionParser.parse('0 8 * * 1-5', { tz: TIMEZONE });
          updateTask(taskId, { next_run: interval.next().toISOString() });
        } catch { /* ignore */ }
        logger.info({ taskId }, 'Auto-registered morning briefing task');
      }
    }

    // Auto-register evening briefing task
    const hasEvening = tasks.some((t) => t.prompt.includes('[Evening Briefing]') && t.status === 'active');
    if (!hasEvening) {
      const paJidEvening = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      )?.[0];
      if (paJidEvening) {
        const taskId = `evening-briefing-${Date.now()}`;
        createTask({
          id: taskId,
          group_folder: MAIN_GROUP_FOLDER,
          chat_jid: paJidEvening,
          prompt: '[Evening Briefing] Collect end-of-day status and post an evening briefing to #briefing.',
          schedule_type: 'cron',
          schedule_value: '0 22 * * 0-6',
          context_mode: 'isolated',
          next_run: null,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        const { CronExpressionParser } = await import('cron-parser');
        const { TIMEZONE } = await import('./config.js');
        try {
          const interval = CronExpressionParser.parse('0 22 * * 0-6', { tz: TIMEZONE });
          updateTask(taskId, { next_run: interval.next().toISOString() });
        } catch { /* ignore */ }
        logger.info({ taskId }, 'Auto-registered evening briefing task');
      }
    }
  }

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

const startupTime = Date.now();

function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const slackConnected = channels.some(
        (c) => c.name === 'slack' && c.isConnected(),
      );
      const anyChannelConnected = channels.some((c) => c.isConnected());
      const uptimeSeconds = Math.floor((Date.now() - startupTime) / 1000);

      const status = anyChannelConnected ? 'ok' : 'degraded';
      const statusCode = anyChannelConnected ? 200 : 503;

      const agentMail = agentMailPoller?.getStatus() ?? null;
      const email = emailPoller?.getStatus() ?? null;

      const body = JSON.stringify({
        status,
        slack: { connected: slackConnected },
        channels: channels.map((c) => ({ name: c.name, connected: c.isConnected() })),
        ...(agentMail && { agentMail }),
        ...(email && { email }),
        uptime: uptimeSeconds,
      });

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(WEBHOOK_PORT, TAILSCALE_IP, () => {
    logger.info(
      { host: TAILSCALE_IP, port: WEBHOOK_PORT },
      'Health server listening',
    );
    console.log(`  Health: http://${TAILSCALE_IP}:${WEBHOOK_PORT}/health`);
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Health server error');
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
