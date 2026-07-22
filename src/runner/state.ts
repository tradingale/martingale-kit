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

export function listRuns(): string[] {
  return fs
    .readdirSync(runnerDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}
