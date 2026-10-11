/**
 * The dashboard as a person uses it in the walkthrough's browser: sign-in through the GitHub OAuth
 * test double, the pages a step shows, and the dashboard's own write path. Reads and writes run as
 * `fetch` inside the page, so they carry the page's session cookie and Origin exactly as the React
 * app's requests do.
 */

import { expect, type Page } from "@playwright/test";

import { UseCaseFixture } from "./fixture.ts";

export class Dashboard {
  readonly page: Page;
  readonly url: string;
  /** The owner the page is signed in as, or undefined before the first sign-in. */
  person: string | undefined;

  constructor(page: Page, url: string) {
    this.page = page;
    this.url = url;
  }

  /** Signs the page in as `ownerId`; a page signed in as someone else is signed in again. */
  async signIn(ownerId: string): Promise<void> {
    if (this.person === ownerId) return;
    await this.page.goto(`${this.url}/auth/github?login=${encodeURIComponent(UseCaseFixture.login(ownerId))}`);
    const session = await this.get("/api/session");
    expect(session.owner, "the dashboard session's owner").toBe(ownerId);
    this.person = ownerId;
  }

  /** Opens a dashboard page as `ownerId` and waits for it to load. */
  async open(ownerId: string, path: string): Promise<void> {
    await this.signIn(ownerId);
    await this.page.goto(`${this.url}${path}`);
    await this.page.waitForLoadState("networkidle");
  }

  async get(path: string): Promise<any> {
    const { status, body } = await this.page.evaluate(async (target) => {
      const response = await fetch(target, { headers: { Accept: "application/json" } });
      return { status: response.status, body: await response.text() };
    }, path);
    if (status !== 200) throw new Error(`GET ${path} answered HTTP ${status}: ${body}`);
    return JSON.parse(body);
  }

  async post(path: string, payload: unknown): Promise<{ status: number; body: any }> {
    const { status, body } = await this.page.evaluate(
      async ({ target, json }) => {
        const response = await fetch(target, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: json,
        });
        return { status: response.status, body: await response.text() };
      },
      { target: path, json: JSON.stringify(payload) },
    );
    return { status, body: body === "" ? null : JSON.parse(body) };
  }

  /**
   * One operation on `issueId` through the dashboard's write path (POST /api/operations), written
   * on the issue's current version by the signed-in person.
   */
  async write(issueId: string, type: string, payload: Record<string, unknown>): Promise<{ opId: string; version: number }> {
    const { issue } = await this.get(`/api/issues/${issueId}`);
    const { status, body } = await this.post("/api/operations", {
      issue: Number(issueId),
      type,
      base_version: issue.version,
      payload,
    });
    if (status !== 201) throw new Error(`${this.person}'s ${type} on #${issueId} was not applied: HTTP ${status} ${JSON.stringify(body)}`);
    return body;
  }

  async issue(issueId: string): Promise<any> {
    return this.get(`/api/issues/${issueId}`);
  }
}
