/**
 * Host Runner for NanoClaw
 * Spawns `claude -p` as a host process instead of a Docker container.
 * Used for PA (main group) to give it direct access to host tools:
 * bd (beads), Agent Mail MCP, the dev repo, etc.
 *
 * Accepts the same ContainerInput/ContainerOutput interface as container-runner
 * so the call site in index.ts can swap runners transparently.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Re-use the same interfaces from container-runner
import type { ContainerInput, ContainerOutput } from './container-runner.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/home/ubuntu/.local/bin/claude';
// Working directory for host agent — the main project repo
const HOST_CWD = process.env.HOST_AGENT_CWD || '/srv/gluon/dev';

/**
 * Parsed line from `claude -p --output-format stream-json --verbose`
 */
interface StreamJsonMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  [key: string]: unknown;
}

export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const processName = `host-${group.folder}-${Date.now()}`;

  // Build claude CLI args
  const args: string[] = [
    '-p',                                     // Print mode (non-interactive)
    '--output-format', 'stream-json',         // Streaming JSON for live output
    '--verbose',                              // Required for stream-json
    '--permission-mode', 'bypassPermissions',
    '--allow-dangerously-skip-permissions',
  ];

  // Resume session if available
  if (input.sessionId) {
    args.push('--resume', input.sessionId);
  }

  // Set model hint
  if (input.modelHint) {
    args.push('--model', input.modelHint);
  }

  // Load PA identity from group CLAUDE.md via --append-system-prompt
  const groupClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(groupClaudeMd)) {
    const identity = fs.readFileSync(groupClaudeMd, 'utf-8');
    args.push('--append-system-prompt', identity);
    // Also add the group dir so PA can read/write pa-state.md etc.
    args.push('--add-dir', groupDir);
  }

  // Prompt is piped via stdin (not args) to avoid shell escaping issues

  // Build environment — inherit host env so claude sees:
  //   - bd on PATH
  //   - Agent Mail MCP from project settings
  //   - CLAUDE.md from /srv/gluon/dev
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // Unset CLAUDECODE to avoid nesting detection
  delete env.CLAUDECODE;

  logger.info(
    {
      group: group.name,
      processName,
      sessionId: input.sessionId || 'new',
      model: input.modelHint,
      cwd: HOST_CWD,
    },
    'Spawning host agent',
  );

  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: HOST_CWD,
      env,
    });

    // Handle spawn errors (e.g. ENOENT) gracefully instead of crashing
    proc.on('error', (err) => {
      logger.error(
        { group: group.name, processName, err: err.message },
        'Failed to spawn host agent',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Failed to spawn claude: ${err.message}`,
      });
    });

    onProcess(proc, processName);

    // Pipe prompt via stdin and close
    proc.stdin.write(input.prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let newSessionId: string | undefined;
    let timedOut = false;
    let hadOutput = false;
    let outputChain = Promise.resolve();

    // Parse streaming JSON lines from stdout
    let lineBuffer = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Accumulate for logging (with size limit)
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      // Parse line-delimited JSON
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || ''; // Keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg: StreamJsonMessage;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          logger.debug({ host: group.folder }, `Non-JSON line: ${trimmed.slice(0, 100)}`);
          continue;
        }

        // Track session ID from init message
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          newSessionId = msg.session_id;
          logger.debug(
            { group: group.name, sessionId: newSessionId },
            'Host agent session initialized',
          );
        }

        // On result message, emit ContainerOutput via onOutput
        if (msg.type === 'result') {
          hadOutput = true;
          resetTimeout();

          const sessionId = msg.session_id || newSessionId;
          if (sessionId) newSessionId = sessionId;

          const output: ContainerOutput = {
            status: msg.is_error ? 'error' : 'success',
            result: msg.result || null,
            newSessionId: sessionId,
            error: msg.is_error ? (msg.result || 'Unknown error') : undefined,
          };

          if (onOutput) {
            outputChain = outputChain.then(() => onOutput(output));
          }
        }

        // Reset timeout on assistant messages (activity)
        if (msg.type === 'assistant') {
          resetTimeout();
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      if (!stderrTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
        if (chunk.length > remaining) {
          stderr += chunk.slice(0, remaining);
          stderrTruncated = true;
        } else {
          stderr += chunk;
        }
      }
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ host: group.folder }, line);
      }
    });

    // Timeout handling
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, processName }, 'Host agent timeout, sending SIGTERM');
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 15_000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Write log file
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `host-${ts}.log`);
      fs.writeFileSync(logFile, [
        `=== Host Agent Run Log${timedOut ? ' (TIMEOUT)' : ''} ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Process: ${processName}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Session: ${newSessionId || 'unknown'}`,
        `Had Output: ${hadOutput}`,
        ``,
        `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
        stderr,
        ``,
        `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
        stdout,
      ].join('\n'));

      if (timedOut) {
        if (hadOutput) {
          // Timed out after output = idle cleanup, not failure
          logger.info(
            { group: group.name, processName, duration, code },
            'Host agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        resolve({
          status: 'error',
          result: null,
          error: `Host agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration },
          'Host agent exited with error',
        );

        // Try to parse final result from stdout even on error
        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            newSessionId,
            error: `Host agent exited with code ${code}: ${stderr.slice(-200)}`,
          });
        });
        return;
      }

      // Success — resolve with last known state
      outputChain.then(() => {
        logger.info(
          { group: group.name, duration, sessionId: newSessionId },
          'Host agent completed',
        );
        resolve({ status: 'success', result: null, newSessionId });
      });
    });
  });
}
