import { execSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isGitRepo, mergeFile, setupRerereAdapter } from '../merge.js';
import { createTempDir, initGitRepo, cleanup } from './test-helpers.js';

// NOTE: this file deliberately does NOT call process.chdir(). merge.ts takes
// the repository root as an explicit argument, so isolation is by ARGUMENT,
// not by process-global ambient state (dev-2h43mx).

describe('merge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('isGitRepo returns true in a git repo', () => {
    initGitRepo(tmpDir);
    expect(isGitRepo(tmpDir)).toBe(true);
  });

  it('isGitRepo returns false outside a git repo', () => {
    expect(isGitRepo(tmpDir)).toBe(false);
  });

  describe('mergeFile', () => {
    beforeEach(() => {
      initGitRepo(tmpDir);
    });

    it('clean merge with no overlapping changes', () => {
      const base = path.join(tmpDir, 'base.txt');
      const current = path.join(tmpDir, 'current.txt');
      const skill = path.join(tmpDir, 'skill.txt');

      fs.writeFileSync(base, 'line1\nline2\nline3\n');
      fs.writeFileSync(current, 'line1-modified\nline2\nline3\n');
      fs.writeFileSync(skill, 'line1\nline2\nline3-modified\n');

      const result = mergeFile(tmpDir, current, base, skill);
      expect(result.clean).toBe(true);
      expect(result.exitCode).toBe(0);

      const merged = fs.readFileSync(current, 'utf-8');
      expect(merged).toContain('line1-modified');
      expect(merged).toContain('line3-modified');
    });

    it('setupRerereAdapter cleans stale MERGE_HEAD before proceeding', () => {
      // Simulate a stale MERGE_HEAD from a previous crash
      const gitDir = path.join(tmpDir, '.git');
      const headHash = execSync('git rev-parse HEAD', {
        cwd: tmpDir,
        encoding: 'utf-8',
      }).trim();
      fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), headHash + '\n');
      fs.writeFileSync(path.join(gitDir, 'MERGE_MSG'), 'stale merge\n');

      // Write a file for the adapter to work with
      fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'conflicted content');

      // setupRerereAdapter should not throw despite stale MERGE_HEAD
      expect(() =>
        setupRerereAdapter(tmpDir, 'test.txt', 'base', 'ours', 'theirs'),
      ).not.toThrow();

      // MERGE_HEAD should still exist (newly written by setupRerereAdapter)
      expect(fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))).toBe(true);

      // The unmerged entries must have landed in the TEMP repo's index.
      const staged = execSync('git ls-files -u', {
        cwd: tmpDir,
        encoding: 'utf-8',
      });
      expect(staged).toContain('test.txt');
    });

    it('conflict with overlapping changes', () => {
      const base = path.join(tmpDir, 'base.txt');
      const current = path.join(tmpDir, 'current.txt');
      const skill = path.join(tmpDir, 'skill.txt');

      fs.writeFileSync(base, 'line1\nline2\nline3\n');
      fs.writeFileSync(current, 'line1-ours\nline2\nline3\n');
      fs.writeFileSync(skill, 'line1-theirs\nline2\nline3\n');

      const result = mergeFile(tmpDir, current, base, skill);
      expect(result.clean).toBe(false);
      expect(result.exitCode).toBeGreaterThan(0);

      const merged = fs.readFileSync(current, 'utf-8');
      expect(merged).toContain('<<<<<<<');
      expect(merged).toContain('>>>>>>>');
    });
  });
});
