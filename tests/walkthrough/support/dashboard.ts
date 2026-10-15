/**
 * The dashboard as a person uses it in the walkthrough's browser: sign-in through the GitHub OAuth
 * test double, the pages each frame shows, and every decision a person makes, made by pressing the
 * page's own buttons. Reads and posts carry the page's session cookie and the dashboard's Origin,
 * as the React app's requests do.
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
    await this.park();
    const session = await this.get("/api/session");
    expect(session.owner, "the dashboard session's owner").toBe(person);
    this.person = person;
  }

  /**
   * Leaves the app for a blank page. The app re-reads every view on each live message, and each view
   * reads main through the Artifacts binding; under `wrangler dev` that many remote-binding calls drop
   * the binding's connection and stall the agents' own calls. The page loads the app only for a frame
   * or a decision.
   */
  async park(): Promise<void> {
    await this.page.goto("about:blank");
  }

  /** Opens a dashboard page as `person` and waits for it to load. */
  async open(person: string, path: string): Promise<void> {
    await this.signIn(person);
    await this.page.goto(`${this.url}${path}`);
    await this.page.waitForLoadState("networkidle");
  }

  /**
   * The context's cookies for the dashboard, as a Cookie header. The request client leaves out the
   * `__Host-` session cookie on plain-HTTP loopback, which the browser itself treats as secure.
   */
  async #cookie(): Promise<string> {
    // cookies(url) also drops Secure cookies for an http URL, so every cookie is read and matched by host.
    const host = new URL(this.url).hostname;
    return (await this.page.context().cookies())
      .filter((cookie) => cookie.domain.replace(/^\./u, "") === host)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  // Reads and posts go through the browser context's request client with the page's session cookie;
  // each post names the dashboard's Origin as the app's own requests do.
  async get(path: string): Promise<any> {
    const response = await this.page.context().request.get(`${this.url}${path}`, { headers: { Accept: "application/json", Cookie: await this.#cookie() } });
    const body = await response.text();
    if (response.status() !== 200) throw new Error(`GET ${path} answered HTTP ${response.status()}: ${body}`);
    return JSON.parse(body);
  }

  async post(path: string, payload: unknown): Promise<{ status: number; body: any }> {
    const response = await this.page.context().request.post(`${this.url}${path}`, {
      headers: { "Content-Type": "application/json", Accept: "application/json", Origin: this.url, Cookie: await this.#cookie() },
      data: JSON.stringify(payload),
    });
    const status = response.status();
    const body = await response.text();
    let parsed: unknown = body;
    try {
      parsed = body === "" ? null : JSON.parse(body);
    } catch {
      // A plain-text refusal stays text.
    }
    return { status, body: parsed };
  }

  /**
   * One frame of docs/walkthrough.md: `person`'s screen at `path`, captured as `<n>-<name>.png`. With
   * `region` the shot holds that part of the page, the part the frame's question is answered in.
   */
  async frame(name: string, question: string, person: string, path: string, region?: ((page: Page) => Locator) & { readonly view?: string }): Promise<string> {
    // A region that is a tab of the feature page opens that tab through its hash.
    await this.open(person, region?.view === undefined ? path : `${path}#${region.view}`);
    const file = join(this.outDir, `${String(this.frames.length + 1).padStart(2, "0")}-${name}.png`);
    if (region === undefined) await this.page.screenshot({ path: file, fullPage: true });
    else {
      const target = region(this.page);
      await target.first().waitFor({ state: "visible" });
      await target.first().screenshot({ path: file });
    }
    this.frames.push({ file, person, path, question });
    await this.park();
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
  async partState(part: { readonly feature: string; readonly partId: string }): Promise<{ state: string; revision: number; approvedBy: string | null }> {
    const plan = await this.get(`/api/features/${encodeURIComponent(part.feature)}/plan`);
    const found = (plan.parts as { partId: string; approvalState: string; revision: number; approvedBy?: string | null }[]).find((each) => each.partId === part.partId);
    if (found === undefined) throw new Error(`the plan of ${part.feature} has no part ${part.partId}`);
    return { state: found.approvalState, revision: found.revision, approvedBy: found.approvedBy ?? null };
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
    await this.park();
  }

  /** `person` asks for a change to the part on the inbox page, typing `text` into the request field. */
  async requestChange(person: string, part: PartRequest, text: string): Promise<void> {
    await this.open(person, "/inbox");
    const card = this.partRow(part);
    await card.getByRole("button", { name: "Request change" }).click();
    await card.getByLabel("Change to ask for").fill(text);
    await card.getByRole("button", { name: "Send request" }).click();
    await this.#settled(part, "change_requested");
    await this.park();
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
      // Only this pair: a person with two running features beside `blocked` approves each in turn.
      .poll(async () => ((await this.get("/api/overlaps")).requests as { feature: string; blockedFeature: string }[]).some((each) => each.blockedFeature === blocked && each.feature === feature), {
        message: `${person}'s approval of ${blocked}'s start`,
        timeout: 30_000,
      })
      .toBe(false);
    await this.park();
  }
}
