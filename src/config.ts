import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_ONLY',
  'SLACK_BRIEFING_CHANNEL',
  'SLACK_ALERTS_CHANNEL',
  'TAILSCALE_IP',
  'WEBHOOK_PORT',
  'HEALTHCHECK_PING_URL',
  'AGENT_MAIL_API_URL',
  'AGENT_MAIL_AUTH_TOKEN',
  'AGENT_MAIL_PROJECT_KEY',
  'AGENT_MAIL_AGENT_NAME',
  'AGENT_MAIL_TARGET_JID',
  'AGENT_MAIL_POLL_INTERVAL',
  'SLACK_ALERTS_WEBHOOK',
  'MAIL_IMAP_HOST',
  'MAIL_IMAP_PORT',
  'MAIL_IMAP_USER',
  'MAIL_IMAP_PASS',
  'MAIL_SMTP_HOST',
  'MAIL_SMTP_PORT',
  'MAIL_SMTP_USER',
  'MAIL_SMTP_PASS',
  'MAIL_FROM_ADDRESS',
  'MAIL_FROM_NAME',
  'MAIL_TARGET_JID',
  'MAIL_POLL_INTERVAL',
  'MAIN_GROUP_FOLDER',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = envConfig.MAIN_GROUP_FOLDER || 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Slack configuration
export const SLACK_BOT_TOKEN =
  process.env.SLACK_BOT_TOKEN || envConfig.SLACK_BOT_TOKEN || '';
export const SLACK_APP_TOKEN =
  process.env.SLACK_APP_TOKEN || envConfig.SLACK_APP_TOKEN || '';
export const SLACK_ONLY =
  (process.env.SLACK_ONLY || envConfig.SLACK_ONLY) === 'true';
export const SLACK_BRIEFING_CHANNEL =
  process.env.SLACK_BRIEFING_CHANNEL || envConfig.SLACK_BRIEFING_CHANNEL || '';
export const SLACK_ALERTS_CHANNEL =
  process.env.SLACK_ALERTS_CHANNEL || envConfig.SLACK_ALERTS_CHANNEL || '';

// Health endpoint / webhook server
export const TAILSCALE_IP =
  process.env.TAILSCALE_IP || envConfig.TAILSCALE_IP || '0.0.0.0';
export const WEBHOOK_PORT = parseInt(
  process.env.WEBHOOK_PORT || envConfig.WEBHOOK_PORT || '8443',
  10,
);
export const HEALTHCHECK_PING_URL =
  process.env.HEALTHCHECK_PING_URL || envConfig.HEALTHCHECK_PING_URL || '';

// Agent Mail configuration
export const AGENT_MAIL_API_URL =
  process.env.AGENT_MAIL_API_URL || envConfig.AGENT_MAIL_API_URL || '';
export const AGENT_MAIL_AUTH_TOKEN =
  process.env.AGENT_MAIL_AUTH_TOKEN || envConfig.AGENT_MAIL_AUTH_TOKEN || '';
export const AGENT_MAIL_PROJECT_KEY =
  process.env.AGENT_MAIL_PROJECT_KEY || envConfig.AGENT_MAIL_PROJECT_KEY || '';
export const AGENT_MAIL_AGENT_NAME =
  process.env.AGENT_MAIL_AGENT_NAME || envConfig.AGENT_MAIL_AGENT_NAME || 'OrangeFox';
export const AGENT_MAIL_TARGET_JID =
  process.env.AGENT_MAIL_TARGET_JID || envConfig.AGENT_MAIL_TARGET_JID || '';
export const AGENT_MAIL_POLL_INTERVAL = parseInt(
  process.env.AGENT_MAIL_POLL_INTERVAL || envConfig.AGENT_MAIL_POLL_INTERVAL || '15000',
  10,
);

// Out-of-band Slack webhook for critical alerts (works even if bot is degraded)
export const SLACK_ALERTS_WEBHOOK =
  process.env.SLACK_ALERTS_WEBHOOK || envConfig.SLACK_ALERTS_WEBHOOK || '';

// Email (Migadu IMAP/SMTP) configuration
export const MAIL_IMAP_HOST =
  process.env.MAIL_IMAP_HOST || envConfig.MAIL_IMAP_HOST || '';
export const MAIL_IMAP_PORT = parseInt(
  process.env.MAIL_IMAP_PORT || envConfig.MAIL_IMAP_PORT || '993',
  10,
);
export const MAIL_IMAP_USER =
  process.env.MAIL_IMAP_USER || envConfig.MAIL_IMAP_USER || '';
export const MAIL_IMAP_PASS =
  process.env.MAIL_IMAP_PASS || envConfig.MAIL_IMAP_PASS || '';
export const MAIL_SMTP_HOST =
  process.env.MAIL_SMTP_HOST || envConfig.MAIL_SMTP_HOST || '';
export const MAIL_SMTP_PORT = parseInt(
  process.env.MAIL_SMTP_PORT || envConfig.MAIL_SMTP_PORT || '465',
  10,
);
export const MAIL_SMTP_USER =
  process.env.MAIL_SMTP_USER || envConfig.MAIL_SMTP_USER || '';
export const MAIL_SMTP_PASS =
  process.env.MAIL_SMTP_PASS || envConfig.MAIL_SMTP_PASS || '';
export const MAIL_FROM_ADDRESS =
  process.env.MAIL_FROM_ADDRESS || envConfig.MAIL_FROM_ADDRESS || '';
export const MAIL_FROM_NAME =
  process.env.MAIL_FROM_NAME || envConfig.MAIL_FROM_NAME || 'NanoClaw PA';
export const MAIL_TARGET_JID =
  process.env.MAIL_TARGET_JID || envConfig.MAIL_TARGET_JID || AGENT_MAIL_TARGET_JID;
export const MAIL_POLL_INTERVAL = parseInt(
  process.env.MAIL_POLL_INTERVAL || envConfig.MAIL_POLL_INTERVAL || '60000',
  10,
);
