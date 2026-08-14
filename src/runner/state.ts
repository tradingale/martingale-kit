// Local persistence for the runner: the plan-in-database pattern, file
// edition. The plan and the engine state are written to disk BEFORE any
// order is placed and after every cycle, so a crash or reboot recovers by
// replaying the file against venue state (handbook, sections 1 and 4).
import fs from 'node:fs';
import path from 'node:path';
import type { SequencePlan, SequenceState } from '../engine.js';

export interface RunnerFile {
  version: 1;
  createdAt: string;
  symbol: string;
  assetType?: 'crypto' | 'stock';
  venue: 'paper' | 'kraken' | 'alpaca';
  budget: number;
  plan: SequencePlan;
  state: SequenceState;
  /** Fill log for the paper venue so a restart replays the same world. */
  paperFills?: unknown[];
  /**
   * Client ids of paper orders still resting when the last cycle ended. The
   * simulated book lives in memory, so without this a one-shot `cycle` in a
   * new process would not see the active sell and would place another.
   */
  paperOpen?: string[];
  /** Last public price observed by a cycle (display only, never a promise). */
  lastPrice?: number;
  /** When the last reconciliation cycle ran (ISO). */
  lastCycleAt?: string;
}

export function runnerDir(): string {
  // RUNNER_STATE_DIR lets hosted deployments (e.g. a Railway volume) keep
  // the plan files on a persistent mount instead of the ephemeral cwd.
  const dir = process.env.RUNNER_STATE_DIR ?? path.join(process.cwd(), '.martingale-runner');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sequenceFile(sequenceId: string): string {
  return path.join(runnerDir(), `${sequenceId}.json`);
}

export function saveRun(file: RunnerFile, sequenceId: string): void {
  const target = sequenceFile(sequenceId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, target); // atomic: never leave a half-written plan
}

export function loadRun(sequenceId: string): RunnerFile | null {
  const target = sequenceFile(sequenceId);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf-8')) as RunnerFile;
}

/** Remove a persisted sequence file. Returns false when it was already gone. */
export function deleteRun(sequenceId: string): boolean {
  try {
    fs.unlinkSync(sequenceFile(sequenceId));
    return true;
  } catch {
    return false;
  }
}

export function listRuns(): string[] {
  // The state dir also holds non-sequence files (settings.json, keys.env):
  // only files shaped like a sequence id (SYMBOL-timestamp) are runs.
  return fs
    .readdirSync(runnerDir())
    .filter((f) => /^[A-Z0-9]{1,12}-\d+\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''));
}
