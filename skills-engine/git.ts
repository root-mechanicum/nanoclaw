import { execFileSync } from 'child_process';

/**
 * The ONLY place skills-engine is allowed to shell out to git.
 *
 * Every git invocation in this engine mutates or reads a repository, and the
 * repository it acts on MUST be an argument, never ambient `process.cwd()`
 * state. A library that runs `git reset` / `git add` / `git update-index`
 * against an inherited cwd is a loaded gun in whatever repo happens to be the
 * current directory — including the repo its own test suite runs inside.
 *
 * Measured 2026-08-13 (dev-2h43mx): a full `npx vitest run` in /srv/nanoclaw
 * destroyed the live repo's index entry for a tracked, staged file. The tests
 * "isolated" with `process.chdir(tmpDir)`, which is process-global, so the
 * window in which cwd was the real repo was shared with every other git call.
 * The suite exited 0.
 *
 * Invariant (enforced by __tests__/git-sink.test.ts): no other file under
 * skills-engine/ may call execSync/execFileSync/spawnSync with 'git'.
 */

export interface GitRunOptions {
  /** Written to git's stdin. */
  input?: string;
  /** Milliseconds before the child is killed. */
  timeout?: number;
}

/**
 * Run git in `cwd`. Returns trimmed stdout. Throws the raw child_process
 * error on non-zero exit (callers that need the exit code read `err.status`).
 */
export function git(
  cwd: string,
  args: string[],
  opts: GitRunOptions = {},
): string {
  // A required TypeScript parameter still arrives as '' or undefined from
  // JS callers and from `?? ''` accidents. Fail loudly rather than silently
  // falling back to the ambient directory.
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error(
      `git(): an explicit cwd is required (got ${JSON.stringify(cwd)}); ` +
        `refusing to run 'git ${args.join(' ')}' against the inherited working directory`,
    );
  }

  const out = execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: opts.input,
    timeout: opts.timeout,
  });

  return (out ?? '').toString().trim();
}

/**
 * Run git in `cwd`, swallowing failure. Returns true when git exited 0.
 * Use only where a non-zero exit is a legitimate, expected outcome.
 */
export function gitOk(
  cwd: string,
  args: string[],
  opts: GitRunOptions = {},
): boolean {
  try {
    git(cwd, args, opts);
    return true;
  } catch {
    return false;
  }
}
