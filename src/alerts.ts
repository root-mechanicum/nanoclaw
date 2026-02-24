/**
 * Out-of-band Slack alerts via incoming webhook.
 * Works independently of the Slack bot connection — use for critical
 * infrastructure alerts (Agent Mail down, etc.).
 */
import { SLACK_ALERTS_WEBHOOK } from './config.js';
import { logger } from './logger.js';

/**
 * Post an alert to the Slack webhook. Fire-and-forget with 5s timeout.
 * No-op if SLACK_ALERTS_WEBHOOK is not configured.
 */
export function postAlert(text: string): void {
  if (!SLACK_ALERTS_WEBHOOK) return;

  fetch(SLACK_ALERTS_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(5_000),
  }).catch((err) => {
    logger.warn({ err }, 'Failed to post Slack alert webhook');
  });
}
