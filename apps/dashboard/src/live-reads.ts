// How often a page reads its data again on live messages (#217): the live feed's messages are applied
// once per burst, and each read the pages share runs at most once at a time. Pure of React, so it is
// tested with mock timers (test/live-reads.test.ts).

/** How long the live connection gathers messages before the pages see them. */
export const LIVE_BURST_MS = 1000;

/**
 * Gathers items and hands them to `flush` together `wait` ms after the first of them. The window opens
 * on the first item rather than sliding, so a steady stream still reaches the pages once per window.
 */
export function createBurst<M>(wait: number, flush: (items: readonly M[]) => void): { add(item: M): void; cancel(): void } {
  let items: M[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    add(item) {
      items.push(item);
      timer ??= setTimeout(() => {
        const due = items;
        items = [];
        timer = undefined;
        flush(due);
      }, wait);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      items = [];
    },
  };
}

/**
 * One read at a time. Calls made while the read started in the same task are in flight share it, as
 * the effects of one render do; a call made later waits for it and shares one read started after it,
 * so its answer is never older than the call.
 */
export function singleFlight<T>(read: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  let joinable = false;
  let next: Promise<T> | undefined;
  const start = (): Promise<T> => {
    const running = read();
    inFlight = running;
    joinable = true;
    queueMicrotask(() => {
      if (inFlight === running) joinable = false;
    });
    const clear = () => {
      if (inFlight === running) inFlight = undefined;
    };
    running.then(clear, clear);
    return running;
  };
  return () => {
    if (inFlight === undefined) return start();
    if (joinable) return inFlight;
    const after = () => {
      next = undefined;
      return start();
    };
    next ??= inFlight.then(after, after);
    return next;
  };
}

const shared = new WeakMap<() => Promise<unknown>, () => Promise<unknown>>();

/**
 * Reads through the one single-flight reader for `read`, so every hook that reads the same endpoint,
 * such as the team's board and an issue page's sidebar board, shares one request.
 */
export function readShared<T>(read: () => Promise<T>): Promise<T> {
  let reader = shared.get(read);
  if (reader === undefined) {
    reader = singleFlight(read);
    shared.set(read, reader);
  }
  return reader() as Promise<T>;
}
