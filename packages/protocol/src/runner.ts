// How often the runner bridge makes a pass: it pushes the operations Penguin holds for the issues
// repo, then runs its test jobs. `penguin-bridge runner` uses this interval unless --interval sets
// another. The issue page counts an operation still unpushed after one interval as overdue.

/** The runner's pass interval in milliseconds. */
export const RUNNER_INTERVAL_MS = 10_000;
