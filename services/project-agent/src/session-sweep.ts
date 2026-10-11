/** What scheduling the session sweep needs from the ProjectAgent: its session store, clock and scheduler. */
export interface SweepPort {
  /** Marks sessions past their window offline and returns when the next running window ends, if any. */
  sweep(): number | undefined;
  now(): number;
  /** When each `sweepSessions` row in the scheduler fires, in epoch milliseconds. */
  scheduled(): Promise<readonly number[]>;
  /** Adds a `sweepSessions` row firing at `at`, in epoch milliseconds. */
  schedule(at: number): Promise<void>;
}

/** How long after a window ends its sweep runs, so the session is past it. */
export const SWEEP_DELAY_MS = 1_000;

/**
 * Sweeps now, then makes sure a sweep is scheduled while any session runs: after a registration, a
 * heartbeat and every sweep. A row that fires later than now is reused, which keeps one pending row
 * instead of one per heartbeat; it is never later than the one needed, since a heartbeat only moves
 * a window's end later. A row due by now is not reused: it may be a sweep that is running, whose row
 * stays until its callback returns and is then removed with no successor.
 */
export async function scheduleSweep(port: SweepPort): Promise<void> {
  const next = port.sweep();
  if (next === undefined) return;
  const now = port.now();
  if ((await port.scheduled()).some((at) => at > now)) return;
  await port.schedule(next + SWEEP_DELAY_MS);
}
