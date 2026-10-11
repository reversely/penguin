// Who takes part in a thread, and who may resolve it (PRD sections 2 and 4, Layer 2). A thread's
// people are the people it needs, the people who opened, replied to or resolved it, and, for a thread
// Penguin opened for a review that requested changes, that review's reviewer. Resolving a thread is
// allowed to its people only, and only to people: an agent identity replies in a thread, and its
// developer decides with the others when the thread is done.

import { anchoredReview, PENGUIN_AUTHOR_SEGMENT, type Author } from "@penguin/protocol";

/** A thread, as the issue index holds it. */
export interface ThreadRecord {
  readonly anchor: string | null;
  /** Author segments of everyone who opened, replied to or resolved the thread. */
  readonly participants: readonly string[];
  readonly needsPersonIds: readonly string[];
}

export type ThreadRight = { readonly allowed: true } | { readonly allowed: false; readonly message: string };

/**
 * The person behind an author segment: the person, or an identity's owner half (`<owner>.<name>`).
 * Penguin is no person.
 */
export function segmentPerson(segment: string): string | undefined {
  return segment === PENGUIN_AUTHOR_SEGMENT ? undefined : segment.split(".")[0];
}

/**
 * The people of a thread, in order without duplicates: those it needs, those behind its participants,
 * and the reviewer of the review it was opened for. `reviewerOf` answers a review's reviewer on the
 * thread's issue, or undefined.
 */
export function threadPeople(thread: ThreadRecord, reviewerOf: (reviewOpId: string) => string | undefined): string[] {
  const people = new Set(thread.needsPersonIds);
  for (const segment of thread.participants) {
    const person = segmentPerson(segment);
    if (person !== undefined) people.add(person);
  }
  const review = anchoredReview(thread.anchor);
  const reviewer = review === null ? undefined : reviewerOf(review);
  if (reviewer !== undefined) people.add(reviewer);
  return [...people];
}

/** Decide whether `author` may resolve the thread: a person among the thread's people. */
export function threadResolveRight(
  author: Author,
  thread: ThreadRecord,
  reviewerOf: (reviewOpId: string) => string | undefined,
): ThreadRight {
  const people = threadPeople(thread, reviewerOf);
  if (!("person" in author)) {
    const who = "identity" in author ? `identity ${author.identity}` : "Penguin";
    return { allowed: false, message: `${who} cannot resolve a thread; one of its people can (${people.join(", ")})` };
  }
  if (people.includes(author.person)) return { allowed: true };
  return {
    allowed: false,
    message: `${author.person} takes no part in the thread; one of its people can resolve it (${people.join(", ")})`,
  };
}
