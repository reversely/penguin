/**
 * The dashboard as a person uses it in the walkthrough's browser: sign-in through the GitHub OAuth
 * test double, the pages each frame shows, and every decision a person makes, made by pressing the
 * page's own buttons. Reads run as `fetch` inside the page, so they carry the page's session cookie
 * and Origin exactly as the React app's requests do.
 */

import { expect, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";

import { loginOf } from "./fixture.ts";

/** A plan part as GET /api/plan-parts lists it for the signed-in person. */
export interface PartRequest {
  readonly feature: string;
  readonly partId: string;
  readonly revision: number;
  readonly ask: string;
  readonly state: string;
  readonly routing: { readonly inPerson: boolean; readonly reasons: readonly unknown[] };
  readonly reviews: readonly Record<string, any>[];
}

/** The part's number as the inbox card's heading shows it, `#<n>`. */
const partNumber = (partId: string): string => partId.slice(partId.lastIndexOf("#"));

export class Dashboard {
  readonly page: Page;
  readonly url: string;
  readonly outDir: string;
  /** The person the page is signed in as, or undefined before the first sign-in. */
  person: string | undefined;
  /** Each frame captured: its file, the person whose screen it is and the page. */
  readonly frames: { readonly file: string; readonly person: string; readonly path: string; readonly question: string }[] = [];

  constructor(page: Page, url: string, outDir: string) {
    this.page = page;
    this.url = url;
    this.outDir = outDir;
  }

  /** Signs the page in as `person`; a page signed in as someone else is signed in again. */
  async signIn(person: string): Promise<void> {
    if (this.person === person) return;
    await this.page.goto(`${this.url}/auth/github?login=${encodeURIComponent(loginOf(person))}`);
    const session = await this.get("/api/session");
    expect(session.owner, "the dashboard session's owner").toBe(person);
    this.person = person;
  }

  /** Opens a dashboard page as `person` and waits for it to load. */
  async open(person: string, path: string): Promise<void> {
    await this.signIn(person);
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
    let parsed: unknown = body;
    try {
      parsed = body === "" ? null : JSON.parse(body);
    } catch {
      // A plain-text refusal stays text.
    }
    return { status, body: parsed };
  }

  /**
   * One frame of docs/demo-story.md: `person`'s screen at `path`, captured as `<n>-<name>.png`. With
   * `region` the shot holds that part of the page, the part the frame's question is answered in.
   */
  async frame(name: string, question: string, person: string, path: string, region?: (page: Page) => Locator): Promise<string> {
    await this.open(person, path);
    const file = join(this.outDir, `${String(this.frames.length + 1).padStart(2, "0")}-${name}.png`);
    if (region === undefined) await this.page.screenshot({ path: file, fullPage: true });
    else {
      const target = region(this.page);
      await target.first().waitFor({ state: "visible" });
      await target.first().screenshot({ path: file });
    }
    this.frames.push({ file, person, path, question });
    return file;
  }

  /** The inbox's card of one feature's plan: its reviews and the signed-in person's parts. */
  planCard(feature: string): Locator {
    return this.page
      .locator('section[aria-labelledby="approvals-plans"] article.plan-card')
      .filter({ has: this.page.getByRole("heading", { name: feature, exact: true }) });
  }

  /** One part's row in its plan's card, where the person decides it. */
  partRow(part: { readonly feature: string; readonly partId: string }): Locator {
    return this.planCard(part.feature)
      .locator("li.plan-part")
      .filter({ has: this.page.locator("h4.part-title", { hasText: new RegExp(`^Part #${partNumber(part.partId).slice(1)}(?!\\d)`, "u") }) });
  }

  /** The parts that wait on the signed-in person. */
  async partsWaiting(person: string): Promise<PartRequest[]> {
    await this.signIn(person);
    const answer = await this.get("/api/plan-parts");
    return answer.parts as PartRequest[];
  }

  /** The part's state in its feature's newest plan, as the signed-in person reads it. */
  async partState(part: { readonly feature: string; readonly partId: string }): Promise<{ state: string; revision: number }> {
    const plan = await this.get(`/api/features/${encodeURIComponent(part.feature)}/plan`);
    const found = (plan.parts as { partId: string; approvalState: string; revision: number }[]).find((each) => each.partId === part.partId);
    if (found === undefined) throw new Error(`the plan of ${part.feature} has no part ${part.partId}`);
    return { state: found.approvalState, revision: found.revision };
  }

  async #settled(part: PartRequest, state: string): Promise<void> {
    await expect
      .poll(async () => (await this.partState(part)).state, { message: `${part.partId} reads ${state}`, timeout: 30_000 })
      .toBe(state);
  }

  /** `person` approves the part's current revision on the inbox page by pressing its Approve button. */
  async approvePart(person: string, part: PartRequest): Promise<void> {
    await this.open(person, "/inbox");
    await this.partRow(part).getByRole("button", { name: `Approve revision ${part.revision}` }).click();
    await this.#settled(part, "approved");
  }

  /** `person` asks for a change to the part on the inbox page, typing `text` into the request field. */
  async requestChange(person: string, part: PartRequest, text: string): Promise<void> {
    await this.open(person, "/inbox");
    const card = this.partRow(part);
    await card.getByRole("button", { name: "Request change" }).click();
    await card.getByLabel("Change to ask for").fill(text);
    await card.getByRole("button", { name: "Send request" }).click();
    await this.#settled(part, "change_requested");
  }

  /** `person` approves the start of `blocked` beside their own `feature`, on the inbox's Overlapping starts card. */
  async approveStart(person: string, feature: string, blocked: string): Promise<void> {
    await this.open(person, "/inbox");
    const card = this.page
      .locator('section[aria-labelledby="approvals-overlaps"] article.approval-card')
      .filter({ has: this.page.getByRole("heading", { name: blocked, exact: true }) })
      .filter({ hasText: feature });
    await card.getByRole("button", { name: "Approve start" }).click();
    await expect
      .poll(async () => ((await this.get("/api/overlaps")).requests as { blockedFeature: string }[]).some((each) => each.blockedFeature === blocked), {
        message: `${person}'s approval of ${blocked}'s start`,
        timeout: 30_000,
      })
      .toBe(false);
  }
}
