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
import { trackBlocker, getStaleBlockers, escalateBlocker } from './blocker-tracker.js';
import { EmailPoller } from './email-poller.js';
import { EmailSender } from './email-sender.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { SlackChannel } from './channels/slack.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
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
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

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

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        providerHint: executionProfile.providerHint,
        modelHint: executionProfile.modelHint,
        providerReason: executionProfile.reason,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

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

    if ((aupPoisoned || authPoisoned) && output.newSessionId) {
      logger.warn(
        { group: group.name, sessionId: output.newSessionId, reason: aupPoisoned ? 'aup' : 'auth' },
        `${aupPoisoned ? 'AUP refusal' : 'Auth failure'} detected, clearing poisoned session`,
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
            // Active container: only pipe non-email messages.
            // Emails piped mid-query get lost (model doesn't attend to them).
            // They stay in DB and get included in the next fresh invocation.
            const nonEmailMessages = messagesToSend.filter(
              (m) => !m.id.startsWith('email-'),
            );
            const hasEmails = nonEmailMessages.length < messagesToSend.length;
            if (nonEmailMessages.length > 0) {
              const nonEmailFormatted = formatMessages(nonEmailMessages);
              if (queue.sendMessage(chatJid, nonEmailFormatted)) {
                logger.debug(
                  { chatJid, count: nonEmailMessages.length, emailsDeferred: hasEmails },
                  'Piped messages to active container',
                );
                // If there are pending emails, DON'T advance cursor —
                // otherwise piped non-emails after an email would jump
                // the cursor past the email, permanently skipping it.
                // The piped messages will be re-included next invocation
                // (harmless — they're in session history already).
                if (!hasEmails) {
                  lastAgentTimestamp[chatJid] =
                    nonEmailMessages[nonEmailMessages.length - 1].timestamp;
                  saveState();
                }
                channel.setTyping?.(chatJid, true)?.catch((err) =>
                  logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
                );
              }
            }
            // Email messages stay unadvanced — picked up next invocation
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
        // Track [BLOCKED] messages for escalation
        const blockedMatch = text.match(/^\[BLOCKED\] (.+?): (.+)$/);
        if (blockedMatch) {
          const idMatch = text.match(/am-(\d+)/);
          if (idMatch) trackBlocker(parseInt(idMatch[1], 10), blockedMatch[1], blockedMatch[2]);
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
      pollIntervalMs: MAIL_POLL_INTERVAL,
      onDown: () => postAlert('Email (IMAP) is unreachable. Inbound email processing is offline.'),
      onRecovered: () => postAlert('Email (IMAP) connection restored.'),
    });
    await emailPoller.start();
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
