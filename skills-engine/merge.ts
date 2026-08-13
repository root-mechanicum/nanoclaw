import fs from 'fs';
import path from 'path';

import { git, gitOk } from './git.js';
import { MergeResult } from './types.js';

/**
 * Every function in this module takes the repository root as its FIRST
 * argument. It is deliberately not optional and does not default to
 * `process.cwd()` — see the header of ./git.ts (dev-2h43mx).
 */

export function isGitRepo(cwd: string): boolean {
  return gitOk(cwd, ['rev-parse', '--git-dir']);
}

/**
 * Run git merge-file to three-way merge files.
 * Modifies currentPath in-place.
 * Returns { clean: true, exitCode: 0 } on clean merge,
 * { clean: false, exitCode: N } on conflict (N = number of conflicts).
 */
export function mergeFile(
  cwd: string,
  currentPath: string,
  basePath: string,
  skillPath: string,
): MergeResult {
  try {
    git(cwd, ['merge-file', currentPath, basePath, skillPath]);
    return { clean: true, exitCode: 0 };
  } catch (err: any) {
    const exitCode = err.status ?? 1;
    if (exitCode > 0) {
      // Positive exit code = number of conflicts
      return { clean: false, exitCode };
    }
    // Negative exit code = error
    throw new Error(`git merge-file failed: ${err.message}`);
  }
}

/**
 * Set up unmerged index entries for rerere adapter.
 * Creates stages 1/2/3 so git rerere can record/resolve conflicts.
 */
export function setupRerereAdapter(
  cwd: string,
  filePath: string,
  baseContent: string,
  oursContent: string,
  theirsContent: string,
): void {
  if (!isGitRepo(cwd)) return;

  const gitDir = resolveGitDir(cwd);

  // Clean up stale MERGE_HEAD from a previous crash
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
    cleanupMergeState(cwd, filePath);
  }

  // Hash objects into git object store
  const baseHash = git(cwd, ['hash-object', '-w', '--stdin'], {
    input: baseContent,
  });
  const oursHash = git(cwd, ['hash-object', '-w', '--stdin'], {
    input: oursContent,
  });
  const theirsHash = git(cwd, ['hash-object', '-w', '--stdin'], {
    input: theirsContent,
  });

  // Create unmerged index entries (stages 1/2/3)
  const indexInfo = [
    `100644 ${baseHash} 1\t${filePath}`,
    `100644 ${oursHash} 2\t${filePath}`,
    `100644 ${theirsHash} 3\t${filePath}`,
  ].join('\n');

  git(cwd, ['update-index', '--index-info'], { input: indexInfo });

  // Set MERGE_HEAD and MERGE_MSG (required for rerere)
  const headHash = git(cwd, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), headHash + '\n');
  fs.writeFileSync(
    path.join(gitDir, 'MERGE_MSG'),
    `Skill merge: ${filePath}\n`,
  );
}

/**
 * Run git rerere to record or auto-resolve conflicts.
 * Checks `filePath` (an absolute working-tree path) for remaining conflict markers.
 * Returns true if rerere auto-resolved the conflict.
 */
export function runRerere(cwd: string, filePath: string): boolean {
  if (!isGitRepo(cwd)) return false;

  try {
    git(cwd, ['rerere']);

    // Check if the specific working tree file still has conflict markers.
    // rerere resolves the working tree but does NOT update the index,
    // so checking unmerged index entries would give a false negative.
    const content = fs.readFileSync(filePath, 'utf-8');
    return !content.includes('<<<<<<<');
  } catch {
    return false;
  }
}

/**
 * Clean up merge state after rerere operations.
 *
 * `filePath` is REQUIRED: only that path's index entries are reset, so the
 * user's pre-existing staged changes survive. The former bare `git reset`
 * fallback (which unstaged the WHOLE index of whatever repo git happened to
 * be pointed at) has been removed — an unscoped index reset has no safe use
 * inside a library (dev-2h43mx).
 */
export function cleanupMergeState(cwd: string, filePath: string): void {
  if (!isGitRepo(cwd)) return;

  const gitDir = resolveGitDir(cwd);

  // Remove merge markers
  const mergeHead = path.join(gitDir, 'MERGE_HEAD');
  const mergeMsg = path.join(gitDir, 'MERGE_MSG');
  if (fs.existsSync(mergeHead)) fs.unlinkSync(mergeHead);
  if (fs.existsSync(mergeMsg)) fs.unlinkSync(mergeMsg);

  // Reset only the specific file's unmerged index entries. May exit non-zero
  // if nothing is staged for that path, which is fine.
  gitOk(cwd, ['reset', '--', filePath]);
}

/** Absolute path to the .git directory of the repo rooted at `cwd`. */
function resolveGitDir(cwd: string): string {
  const gitDir = git(cwd, ['rev-parse', '--git-dir']);
  return path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir);
}
