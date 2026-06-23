/**
 * Shared OAuth token refresh for NanoClaw agent runners (dev-d7ynt).
 *
 * Both runners spawn `claude` against Claude Code's host credential store
 * (~/.claude/.credentials.json — a Claude Max subscription OAuth token, NOT an
 * ANTHROPIC_API_KEY and NOT pass-cli, which only manages Slack/mail/GitHub
 * secrets). That token has a ~8h TTL and a SINGLE-USE refresh token that rotates
 * on every refresh.
 *
 * ROOT CAUSE of the 2026-06-20→21 PA 401 burst (~50 "API Error: 401 Invalid
 * authentication credentials" over 27h): the host path (PA, since 2026-03-12)
 * delegated token refresh to the headless `claude -p` it spawned, with no
 * coordination. The container path already centralized refresh in nanoclaw's
 * single long-lived process (refreshOAuthTokenIfNeeded, formerly private to
 * container-runner.ts) — refreshing proactively when <1h remains and persisting
 * the rotated single-use refresh token back to disk. The host path had none of
 * that, so PA could spawn with a near-dead token and, because the refresh token
 * is single-use and shared across every claude process on the host, lose a
 * rotation race that leaves the on-disk credentials in a 401 state. A headless
 * `claude -p` cannot perform the interactive re-login needed to recover, so
 * every ~30min escalated sweep re-spawned against the same broken token until a
 * human re-authed 27h later.
 *
 * This module extracts the proven container-path refresh so BOTH runners share
 * one centralized, pre-spawn refresh (single source of truth). The host runner
 * additionally injects the freshly-refreshed access token into the spawned
 * process env (CLAUDE_CODE_OAUTH_TOKEN) so `claude -p` uses the token nanoclaw
 * just refreshed instead of independently re-reading/re-refreshing the file.
 *
 * NOTE: proactive refresh fixes the COMMON failure (near-expiry spawn + rotation
 * race). A genuinely revoked/expired *refresh* token still requires a human
 * interactive `claude` re-login — that residual case is surfaced by the
 * transient-error flood gate (noop-suppression.ts), which forwards the first
 * 401 to #pa as operator signal.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

// OAuth refresh constants (mirror Claude Code's own refresh flow)
const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers';
const OAUTH_REFRESH_THRESHOLD_MS = 60 * 60 * 1000; // Refresh if < 1 hour remaining

export interface CredentialsFile {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/** Default path to Claude Code's credential store. */
export function defaultCredPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

/**
 * Refresh the OAuth token if it's near expiry.
 * Writes new tokens back to the credentials file (refresh tokens are single-use).
 *
 * Best-effort: any failure (missing file, network error, non-OK response) is
 * logged and swallowed — the caller continues with whatever token is on disk.
 */
export async function refreshOAuthTokenIfNeeded(credPath: string): Promise<void> {
  let creds: CredentialsFile;
  try {
    creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  } catch {
    return; // No credentials file — nothing to refresh
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth?.refreshToken || !oauth.expiresAt) return;

  const expiresAt = new Date(oauth.expiresAt).getTime();
  const now = Date.now();
  const remaining = expiresAt - now;

  if (remaining > OAUTH_REFRESH_THRESHOLD_MS) {
    return; // Token is still fresh
  }

  logger.info(
    { remainingMs: remaining, expiresAt: oauth.expiresAt },
    'OAuth token near expiry, refreshing',
  );

  try {
    const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/1.0',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: OAUTH_SCOPE,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, 'OAuth token refresh failed');
      return;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    // Update credentials (refresh_token is single-use — must persist the new one)
    oauth.accessToken = data.access_token;
    oauth.refreshToken = data.refresh_token || oauth.refreshToken;
    oauth.expiresAt = new Date(now + data.expires_in * 1000).toISOString();

    fs.writeFileSync(credPath, JSON.stringify(creds, null, 2) + '\n');

    logger.info({ expiresAt: oauth.expiresAt }, 'OAuth token refreshed successfully');
  } catch (err) {
    logger.error({ err }, 'OAuth token refresh request failed');
  }
}

/**
 * Return a fresh OAuth access token, refreshing the on-disk credentials first if
 * near expiry. Returns null if there is no usable token (no file / malformed /
 * no accessToken) — callers should fall back to whatever auth `claude` finds on
 * its own rather than failing the spawn.
 */
export async function getFreshOAuthToken(
  credPath: string = defaultCredPath(),
): Promise<string | null> {
  try {
    await refreshOAuthTokenIfNeeded(credPath);
  } catch (err) {
    logger.warn({ err }, 'OAuth refresh check failed, continuing with existing token');
  }

  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as CredentialsFile;
    return creds?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}
