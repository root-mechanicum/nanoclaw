import { execSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { git, gitOk } from '../git.js';
import { createTempDir, initGitRepo, cleanup } from './test-helpers.js';

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('git sink', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('runs in the cwd it is given, not process.cwd()', () => {
    initGitRepo(tmpDir);
    const gitDir = git(tmpDir, ['rev-parse', '--absolute-git-dir']);
    // fs.realpath: macOS /var -> /private/var, Linux is a no-op.
    expect(fs.realpathSync(gitDir)).toBe(
      fs.realpathSync(path.join(tmpDir, '.git')),
    );
    expect(gitDir.startsWith(fs.realpathSync(process.cwd()))).toBe(false);
  });

  it('throws on an empty cwd instead of inheriting the ambient directory', () => {
    expect(() => git('', ['status'])).toThrow(/explicit cwd is required/);
    // Same for the values a sloppy `?? ''` / JS caller can produce.
    expect(() => git(undefined as unknown as string, ['status'])).toThrow(
      /explicit cwd is required/,
    );
    expect(gitOk('', ['status'])).toBe(false);
  });

  it('propagates the child exit code so callers can read err.status', () => {
    initGitRepo(tmpDir);
    let status: number | undefined;
    try {
      git(tmpDir, ['rev-parse', '--verify', 'refs/heads/nope']);
    } catch (err: any) {
      status = err.status;
    }
    expect(status).toBeGreaterThan(0);
  });

  /**
   * The population invariant. Naming the files fixed in dev-2h43mx would pin
   * the incident; these key on the property instead, so a NEW file that
   * reintroduces the hazard fails here.
   *
   * `gitCallSites` finds every subprocess invocation of git and reports
   * whether that call supplies an explicit `cwd:`. A call is examined over a
   * small window (the call line plus the next few) because these calls are
   * routinely formatted across several lines.
   */
  const WINDOW = 6;

  interface CallSite {
    file: string;
    line: number;
    text: string;
    hasCwd: boolean;
    isTest: boolean;
  }

  function gitCallSites(): CallSite[] {
    const sites: CallSite[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (full === path.join(ENGINE_DIR, 'git.ts')) continue;

        const lines = fs.readFileSync(full, 'utf-8').split('\n');
        lines.forEach((line, i) => {
          if (!/\b(execSync|execFileSync|spawnSync|spawn)\s*\(/.test(line)) return;
          // The offence is a *git* invocation, not any subprocess: `diff`,
          // `npm install` and manifest-supplied test commands are legitimate.
          if (!/['"`]git[ '"`]/.test(line)) return;

          const windowText = lines.slice(i, i + WINDOW).join('\n');
          sites.push({
            file: path.relative(ENGINE_DIR, full),
            line: i + 1,
            text: line.trim(),
            hasCwd: /\bcwd\s*:/.test(windowText),
            isTest: full.includes(`${path.sep}__tests__${path.sep}`),
          });
        });
      }
    };
    walk(ENGINE_DIR);
    return sites;
  }

  it('detector negative control: the matcher can actually see a git call site', () => {
    // A `toEqual([])` on a broken matcher passes forever. Prove the matcher
    // fires on real code before trusting either assertion below: the test
    // helpers legitimately shell out to git, so this must be non-empty.
    const sites = gitCallSites();
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((s) => s.file.includes('test-helpers.ts'))).toBe(true);
    // ...and it must be able to see BOTH dispositions, or the `hasCwd` field
    // is untested. Every surviving call site carries a cwd, so:
    expect(sites.every((s) => s.hasCwd)).toBe(true);
    // Synthetic falsifier for the cwd arm, exercised on the same regexes.
    // Assembled from fragments so this very line is not itself picked up as a
    // call site by the scanner above.
    const bad = 'exec' + "Sync('git status', { stdio: 'pipe' })";
    expect(/\b(execSync|execFileSync|spawnSync|spawn)\s*\(/.test(bad)).toBe(true);
    expect(/['"`]git[ '"`]/.test(bad)).toBe(true);
    expect(/\bcwd\s*:/.test(bad)).toBe(false);
  });

  it('no production file under skills-engine/ shells out to git directly', () => {
    const offenders = gitCallSites()
      .filter((s) => !s.isTest)
      .map((s) => `${s.file}:${s.line}: ${s.text}`);
    expect(offenders).toEqual([]);
  });

  it('every git call in the tests supplies an explicit cwd', () => {
    const offenders = gitCallSites()
      .filter((s) => s.isTest && !s.hasCwd)
      .map((s) => `${s.file}:${s.line}: ${s.text}`);
    expect(offenders).toEqual([]);
  });

  /**
   * Regression guard for the exact loss measured in dev-2h43mx: the engine's
   * merge-state cleanup must never unstage anything outside the path it is
   * given.
   */
  it('cleanupMergeState leaves unrelated staged changes alone', async () => {
    initGitRepo(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'bystander.txt'), 'staged content\n');
    fs.writeFileSync(path.join(tmpDir, 'target.txt'), 'target\n');
    execSync('git add bystander.txt target.txt', { cwd: tmpDir, stdio: 'pipe' });

    const { cleanupMergeState } = await import('../merge.js');
    cleanupMergeState(tmpDir, 'target.txt');

    const staged = git(tmpDir, ['diff', '--cached', '--name-only']);
    expect(staged.split('\n')).toContain('bystander.txt');
  });
});
