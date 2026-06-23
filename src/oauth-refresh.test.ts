import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  refreshOAuthTokenIfNeeded,
  getFreshOAuthToken,
} from './oauth-refresh.js';

function writeCreds(p: string, oauth: Record<string, unknown> | null): void {
  fs.writeFileSync(p, JSON.stringify(oauth ? { claudeAiOauth: oauth } : {}, null, 2));
}

describe('oauth-refresh', () => {
  let tmpDir: string;
  let credPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-test-'));
    credPath = path.join(tmpDir, '.credentials.json');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does NOT refresh a token that is still fresh (>1h remaining)', async () => {
    const future = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    writeCreds(credPath, {
      accessToken: 'fresh-access',
      refreshToken: 'rt-1',
      expiresAt: future,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await refreshOAuthTokenIfNeeded(credPath);

    expect(fetchSpy).not.toHaveBeenCalled();
    const after = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    expect(after.claudeAiOauth.accessToken).toBe('fresh-access');
  });

  it('refreshes and persists the rotated single-use refresh token when near expiry', async () => {
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30m left
    writeCreds(credPath, {
      accessToken: 'old-access',
      refreshToken: 'rt-old',
      expiresAt: soon,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'rt-new',
        expires_in: 28800,
      }),
    } as Response);

    await refreshOAuthTokenIfNeeded(credPath);

    const after = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    expect(after.claudeAiOauth.accessToken).toBe('new-access');
    // Single-use refresh token MUST be persisted, else the next refresh 401s
    expect(after.claudeAiOauth.refreshToken).toBe('rt-new');
    expect(new Date(after.claudeAiOauth.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('keeps the existing refresh token if the response omits a new one', async () => {
    const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    writeCreds(credPath, {
      accessToken: 'old-access',
      refreshToken: 'rt-keep',
      expiresAt: soon,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-access', expires_in: 28800 }),
    } as Response);

    await refreshOAuthTokenIfNeeded(credPath);

    const after = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    expect(after.claudeAiOauth.refreshToken).toBe('rt-keep');
  });

  it('swallows a failed refresh (non-OK) without throwing or corrupting the file', async () => {
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    writeCreds(credPath, {
      accessToken: 'old-access',
      refreshToken: 'rt-old',
      expiresAt: soon,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    } as Response);

    await expect(refreshOAuthTokenIfNeeded(credPath)).resolves.toBeUndefined();
    const after = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    expect(after.claudeAiOauth.accessToken).toBe('old-access');
  });

  it('is a no-op when the credentials file is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      refreshOAuthTokenIfNeeded(path.join(tmpDir, 'nope.json')),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('getFreshOAuthToken returns the access token from a fresh file', async () => {
    const future = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    writeCreds(credPath, {
      accessToken: 'the-token',
      refreshToken: 'rt-1',
      expiresAt: future,
    });
    const token = await getFreshOAuthToken(credPath);
    expect(token).toBe('the-token');
  });

  it('getFreshOAuthToken returns null when there is no usable token', async () => {
    const token = await getFreshOAuthToken(path.join(tmpDir, 'missing.json'));
    expect(token).toBeNull();
  });
});
