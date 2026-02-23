import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- @slack/bolt mock ---

const appRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('@slack/bolt', () => {
  const LogLevel = { WARN: 'warn' };

  class MockApp {
    messageHandlers: Array<(args: any) => Promise<void>> = [];
    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U999BOT' }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
      users: {
        info: vi.fn().mockResolvedValue({
          user: {
            profile: { display_name: 'Alice' },
            real_name: 'Alice Smith',
            name: 'alice',
          },
        }),
      },
      conversations: {
        info: vi.fn().mockResolvedValue({
          channel: { name: 'general' },
        }),
      },
    };
    private _started = false;

    constructor(_opts: any) {
      appRef.current = this;
    }

    message(handler: (args: any) => Promise<void>) {
      this.messageHandlers.push(handler);
    }

    async start() {
      this._started = true;
    }

    async stop() {
      this._started = false;
    }
  }

  return { App: MockApp, LogLevel };
});

import { SlackChannel, SlackChannelOpts } from './slack.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SlackChannelOpts>,
): SlackChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'sl:C0123456789': {
        name: '#pa',
        folder: 'pa',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessage(overrides: {
  channel?: string;
  text?: string;
  user?: string;
  ts?: string;
  bot_id?: string;
  subtype?: string;
  files?: any[];
}) {
  const base: any = {
    channel: overrides.channel ?? 'C0123456789',
    text: overrides.text ?? 'Hello everyone',
    user: overrides.user ?? 'U12345',
    ts: overrides.ts ?? '1704067200.000000',
  };
  if (overrides.bot_id) base.bot_id = overrides.bot_id;
  if (overrides.subtype) base.subtype = overrides.subtype;
  if (overrides.files) base.files = overrides.files;
  return base;
}

function currentApp() {
  return appRef.current;
}

async function triggerMessage(message: any) {
  for (const h of currentApp().messageHandlers) {
    await h({ message, say: vi.fn() });
  }
}

// --- Tests ---

describe('SlackChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() and is connected', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);

      expect(channel.isConnected()).toBe(false);
    });

    it('gets bot user ID on connect', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      expect(currentApp().client.auth.test).toHaveBeenCalled();
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(createMessage({ text: 'Hello everyone' }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sl:C0123456789',
        expect.any(String),
        '#general',
        'slack',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'sl:C0123456789',
        expect.objectContaining({
          chat_jid: 'sl:C0123456789',
          sender: 'U12345',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(
        createMessage({ channel: 'C9999999999', text: 'Unknown' }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sl:C9999999999',
        expect.any(String),
        expect.any(String),
        'slack',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores bot messages', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(
        createMessage({ bot_id: 'B999', text: 'I am a bot' }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores message subtypes (edits, deletes)', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(
        createMessage({ subtype: 'message_changed', text: 'Edited' }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips empty content', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(createMessage({ text: '' }));

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates <@botUserId> mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(
        createMessage({ text: '<@U999BOT> what time is it?' }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sl:C0123456789',
        expect.objectContaining({
          content: '@Andy what time is it?',
        }),
      );
    });

    it('does not prepend trigger if already present', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(
        createMessage({ text: '@Andy hello <@U999BOT>' }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sl:C0123456789',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('passes through messages without bot mention', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(createMessage({ text: 'hello everyone' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sl:C0123456789',
        expect.objectContaining({
          content: 'hello everyone',
        }),
      );
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    it('stores image attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(
        createMessage({
          text: '',
          files: [{ name: 'photo.png', mimetype: 'image/png' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sl:C0123456789',
        expect.objectContaining({
          content: '[Image: photo.png]',
        }),
      );
    });

    it('stores video attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(
        createMessage({
          text: '',
          files: [{ name: 'clip.mp4', mimetype: 'video/mp4' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sl:C0123456789',
        expect.objectContaining({
          content: '[Video: clip.mp4]',
        }),
      );
    });

    it('includes text content with attachments', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(
        createMessage({
          text: 'Check this out',
          files: [{ name: 'photo.jpg', mimetype: 'image/jpeg' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sl:C0123456789',
        expect.objectContaining({
          content: 'Check this out\n[Image: photo.jpg]',
        }),
      );
    });

    it('handles multiple attachments', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await triggerMessage(
        createMessage({
          text: '',
          files: [
            { name: 'a.png', mimetype: 'image/png' },
            { name: 'b.txt', mimetype: 'text/plain' },
          ],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sl:C0123456789',
        expect.objectContaining({
          content: '[Image: a.png]\n[File: b.txt]',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Slack API', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await channel.sendMessage('sl:C0123456789', 'Hello');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith({
        token: 'xoxb-test',
        channel: 'C0123456789',
        text: 'Hello',
      });
    });

    it('strips sl: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      await channel.sendMessage('sl:C9876543210', 'Test');

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C9876543210' }),
      );
    });

    it('does nothing when app is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);

      // Don't connect
      await channel.sendMessage('sl:C0123456789', 'No app');

      // No error
    });

    it('splits messages exceeding 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SlackChannel('xoxb-test', 'xapp-test', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('sl:C0123456789', longText);

      expect(currentApp().client.chat.postMessage).toHaveBeenCalledTimes(2);
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns sl: JIDs', () => {
      const channel = new SlackChannel('xoxb-test', 'xapp-test', createTestOpts());
      expect(channel.ownsJid('sl:C0123456789')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SlackChannel('xoxb-test', 'xapp-test', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = new SlackChannel('xoxb-test', 'xapp-test', createTestOpts());
      expect(channel.ownsJid('dc:123456789')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SlackChannel('xoxb-test', 'xapp-test', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "slack"', () => {
      const channel = new SlackChannel('xoxb-test', 'xapp-test', createTestOpts());
      expect(channel.name).toBe('slack');
    });
  });
});
