import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { runKeyFor, type ActiveRun, type AgentController, type SendOptions } from './AgentController';
import type { RunUpdate } from '../../../shared/types';
import { toolLabel } from '../../../shared/describeTool';
import { claudeBin, npmCliBeside } from './claudeBin';

/**
 * Drives the local `claude` CLI in headless streaming mode:
 *   claude -p <text> --output-format stream-json --verbose [--resume <id>] [--permission-mode ...]
 *
 * The CLI both streams events back to us (which we relay to the UI) AND appends
 * to the session's JSONL on disk, so the DataSource's file watcher naturally
 * re-renders the robot as it works.
 */
interface Run {
  child: ChildProcess;
  roomId: string;
  sessionId: string | null;
}

export class LocalClaudeController implements AgentController {
  private running = new Map<string, Run>();

  activeRuns(): ActiveRun[] {
    return [...this.running.entries()].map(([runKey, run]) => ({
      runKey,
      roomId: run.roomId,
      sessionId: run.sessionId,
      pendingPermission: null, // CLI engine has no interactive permissions
      busy: true, // one process per message: if it is in the map, it is running
    }));
  }

  interrupt(runKey: string): boolean {
    const run = this.running.get(runKey);
    if (!run) return false;
    run.child.kill('SIGTERM');
    return true;
  }

  respondPermission(_requestId: string, _allow: boolean): boolean {
    return false; // CLI engine has no interactive permissions
  }

  async send(opts: SendOptions, onUpdate: (u: RunUpdate) => void): Promise<void> {
    const { roomId, sessionId, text, mode } = opts;
    const key = runKeyFor(opts);
    if (this.running.has(key)) {
      onUpdate({ runKey: key, roomId, sessionId: sessionId ?? null, phase: 'error', text: 'Already running (CLI engine cannot queue follow-ups)', isError: true });
      return;
    }

    const args = ['-p', text, '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);
    if (mode && mode !== 'default') args.push('--permission-mode', mode);
    // Host extras (skill loadouts ride here) — the CLI's own append flag.
    if (opts.systemPromptAppend) args.push('--append-system-prompt', opts.systemPromptAppend);

    let resolvedSession = sessionId ?? null;

    let child: ChildProcess;
    try {
      // The binary airoom found, by full path — a packaged app's PATH is not a
      // terminal's. An npm .cmd shim is run as the cli.js behind it under this
      // same node, never through a shell with a prompt on the command line.
      const bin = claudeBin() ?? 'claude';
      const cli = npmCliBeside(bin);
      const spawnOpts = { cwd: roomId, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
      child = cli ? spawn(process.execPath, [cli, ...args], spawnOpts) : spawn(bin, args, spawnOpts);
    } catch (err) {
      onUpdate({ runKey: key, roomId, sessionId: resolvedSession, phase: 'error', text: `Failed to start claude: ${String(err)}`, isError: true });
      return;
    }

    const run: Run = { child, roomId, sessionId: resolvedSession };
    this.running.set(key, run);
    onUpdate({ runKey: key, roomId, sessionId: resolvedSession, phase: 'started' });

    const rl = readline.createInterface({ input: child.stdout! });

    return new Promise<void>((resolve) => {
      const finish = () => {
        this.running.delete(key);
        rl.close();
        resolve();
      };

      rl.on('line', (line) => {
        if (!line.trim()) return;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return; // ignore non-JSON noise
        }

        if (ev.session_id) {
          resolvedSession = ev.session_id;
          run.sessionId = resolvedSession;
        }

        if (ev.type === 'system' && ev.subtype === 'init') {
          onUpdate({ runKey: key, roomId, sessionId: resolvedSession, phase: 'started' });
        } else if (ev.type === 'assistant' && ev.message) {
          for (const block of ev.message.content ?? []) {
            if (block.type === 'text' && block.text?.trim()) {
              onUpdate({ runKey: key, roomId, sessionId: resolvedSession, phase: 'assistant', text: block.text });
            } else if (block.type === 'tool_use') {
              onUpdate({ runKey: key, roomId, sessionId: resolvedSession, phase: 'tool', text: toolLabel(block.name, block.input) });
            }
          }
        } else if (ev.type === 'result') {
          onUpdate({
            runKey: key,
            roomId,
            sessionId: resolvedSession,
            phase: ev.is_error ? 'error' : 'result',
            text: typeof ev.result === 'string' ? ev.result : undefined,
            isError: !!ev.is_error,
            cost: ev.total_cost_usd,
          });
        }
      });

      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += d.toString()));

      child.on('error', (err) => {
        onUpdate({ runKey: key, roomId, sessionId: resolvedSession, phase: 'error', text: String(err), isError: true });
        finish();
      });

      child.on('close', (code) => {
        if (code !== 0 && code !== null) {
          onUpdate({
            runKey: key,
            roomId,
            sessionId: resolvedSession,
            phase: 'error',
            text: stderr.trim() || `claude exited with code ${code}`,
            isError: true,
          });
        }
        finish();
      });
    });
  }

  async close(): Promise<void> {
    for (const run of this.running.values()) run.child.kill('SIGTERM');
    this.running.clear();
  }
}

