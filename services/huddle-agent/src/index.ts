import { Agent } from "agents";

/**
 * Runs the verification and review loop of one Huddle issue.
 * For now it only reports its name and a counter kept in its SQL storage.
 */
export class HuddleAgent extends Agent {
  override onStart(): void {
    this.sql`CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`;
    this.sql`INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)`;
  }

  /** POST increments the counter; any other method reads it. */
  override onRequest(request: Request): Response {
    if (request.method === "POST") {
      this.sql`UPDATE counter SET value = value + 1 WHERE id = 1`;
    }
    const [row] = this.sql<{ value: number }>`SELECT value FROM counter WHERE id = 1`;
    return Response.json({ agent: "HuddleAgent", name: this.name, counter: row?.value ?? 0 });
  }
}
