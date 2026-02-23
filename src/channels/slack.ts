import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App | null = null;
  private opts: SlackChannelOpts;
  private botToken: string;
  private appToken: string;
  private botUserId: string | null = null;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];

  constructor(botToken: string, appToken: string, opts: SlackChannelOpts) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // Get bot user ID for mention detection
    const authResult = await this.app.client.auth.test({ token: this.botToken });
    this.botUserId = authResult.user_id as string;
    logger.info({ botUserId: this.botUserId }, 'Slack bot authenticated');

    // Listen for all messages
    this.app.message(async ({ message }) => {
      // Cast to record for field access — Bolt's message union types are complex
      const msg = message as Record<string, any>;

      // Skip bot messages and message_changed/deleted subtypes
      if (msg.bot_id || msg.subtype) return;
      if (!msg.channel) return;

      const channelId = msg.channel as string;
      const chatJid = `sl:${channelId}`;
      let content = (msg.text as string) || '';
      const timestamp = msg.ts
        ? new Date(parseFloat(msg.ts) * 1000).toISOString()
        : new Date().toISOString();
      const sender = (msg.user as string) || 'unknown';
      const msgId = (msg.ts as string) || '';

      // Get sender display name via users.info
      let senderName = sender;
      try {
        const userInfo = await this.app!.client.users.info({
          token: this.botToken,
          user: sender,
        });
        senderName =
          userInfo.user?.profile?.display_name ||
          userInfo.user?.real_name ||
          userInfo.user?.name ||
          sender;
      } catch {
        // Fall back to user ID
      }

      // Translate bot @mentions into trigger format
      if (this.botUserId) {
        const mentionPattern = new RegExp(`<@${this.botUserId}>`, 'g');
        const isBotMentioned = mentionPattern.test(content);

        if (isBotMentioned) {
          // Strip the <@botUserId> mention
          content = content.replace(mentionPattern, '').trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle file attachments — text placeholders (matching Discord/Telegram pattern)
      if (msg.files && msg.files.length > 0) {
        const attachmentDescriptions = (msg.files as any[]).map((file: any) => {
          const mimetype = file.mimetype || '';
          const name = file.name || 'file';
          if (mimetype.startsWith('image/')) {
            return `[Image: ${name}]`;
          } else if (mimetype.startsWith('video/')) {
            return `[Video: ${name}]`;
          } else if (mimetype.startsWith('audio/')) {
            return `[Audio: ${name}]`;
          } else {
            return `[File: ${name}]`;
          }
        });
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Store chat metadata for discovery
      // Try to get channel name
      let chatName = channelId;
      try {
        const channelInfo = await this.app!.client.conversations.info({
          token: this.botToken,
          channel: channelId,
        });
        chatName = (channelInfo.channel as any)?.name
          ? `#${(channelInfo.channel as any).name}`
          : channelId;
      } catch {
        // Fall back to channel ID
      }

      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'slack', true);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Slack channel',
        );
        return;
      }

      // Skip empty content (e.g. message with only unsupported blocks)
      if (!content) return;

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Slack message stored',
      );
    });

    await this.app.start();
    this.connected = true;

    // Flush any messages queued before connection
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush Slack outgoing queue'),
    );

    logger.info(
      { botUserId: this.botUserId },
      'Slack bot connected (Socket Mode)',
    );
    console.log(`\n  Slack bot: ${this.botUserId} (Socket Mode)`);
    console.log(`  Register channels with JID format: sl:<channel-id>\n`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app) {
      logger.warn('Slack app not initialized');
      return;
    }

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      const channelId = jid.replace(/^sl:/, '');

      // Slack has a ~4000 char limit for text blocks — split if needed
      const MAX_LENGTH = 4000;
      if (text.length <= MAX_LENGTH) {
        await this.app.client.chat.postMessage({
          token: this.botToken,
          channel: channelId,
          text,
        });
      } else {
        // Split at paragraph boundaries when possible
        const chunks = splitText(text, MAX_LENGTH);
        for (const chunk of chunks) {
          await this.app.client.chat.postMessage({
            token: this.botToken,
            channel: channelId,
            text: chunk,
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.error(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sl:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.app) {
      await this.app.stop();
      this.app = null;
      logger.info('Slack bot stopped');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Slack doesn't have a direct typing indicator API for bots.
    // The Bolt framework handles this implicitly in some patterns,
    // but there's no explicit sendTyping equivalent.
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.outgoingQueue.length === 0) return;
    logger.info(
      { count: this.outgoingQueue.length },
      'Flushing Slack outgoing queue',
    );
    while (this.outgoingQueue.length > 0) {
      const item = this.outgoingQueue.shift()!;
      try {
        const channelId = item.jid.replace(/^sl:/, '');
        await this.app!.client.chat.postMessage({
          token: this.botToken,
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      } catch (err) {
        logger.error({ jid: item.jid, err }, 'Failed to send queued Slack message');
      }
    }
  }
}

/**
 * Split text into chunks at paragraph boundaries, falling back to
 * hard splits if no paragraph break is found within the limit.
 */
function splitText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split at a double newline (paragraph boundary)
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      // Fall back to single newline
      splitIdx = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIdx === -1 || splitIdx < maxLength / 2) {
      // Hard split at max length
      splitIdx = maxLength;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
