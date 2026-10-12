/**
 * The dashboard's API as a signed-in person uses it: the same routes, cookie and Origin header the
 * React app sends, and the /api/live WebSocket it listens on.
 */

import { parseIndexChanged, type IndexChangedMessage } from "@penguin/protocol";

import type { SignIn } from "./config.ts";

export const SESSION_COOKIE = "__Host-penguin_session";

/** The value of `name` among a response's Set-Cookie headers. */
function setCookieValue(response: Response, name: string): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const separator = pair!.indexOf("=");
    if (pair!.slice(0, separator) === name) return pair!.slice(separator + 1);
  }
  return undefined;
}

/**
 * Signs in through the GitHub OAuth test double, following the three redirects a browser follows,
 * and returns the session cookie's value.
 */
export async function signInThroughDouble(origin: string, login: string): Promise<string> {
  const start = await fetch(`${origin}/auth/github?login=${encodeURIComponent(login)}`, { redirect: "manual" });
  const oauth = start.headers.getSetCookie().map((header) => header.split(";")[0]).join("; ");
  const authorize = await fetch(start.headers.get("Location")!, { redirect: "manual" });
  const callback = await fetch(authorize.headers.get("Location")!, { redirect: "manual", headers: { Cookie: oauth } });
  const session = setCookieValue(callback, SESSION_COOKIE);
  if (!session) throw new Error(`sign-in as ${login} ended at ${callback.headers.get("Location")} without a session`);
  return session;
}

export class LiveSocket {
  readonly messages: IndexChangedMessage[] = [];
  readonly #socket: WebSocket;
  readonly #waiters = new Set<() => void>();

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = parseIndexChanged(event.data);
      if (message === undefined) return;
      this.messages.push(message);
      for (const wake of this.#waiters) wake();
    });
  }

  /** Resolves with the first message after `from` that names `issueId`, or rejects after `timeoutMs`. */
  waitForIssue(issueId: string, from: number, timeoutMs: number): Promise<IndexChangedMessage> {
    return this.#waitFor((message) => message.issues.includes(issueId), from, timeoutMs, `issue ${issueId}`);
  }

  /** Resolves with the first message after `from` that names a session change of `handle`. */
  waitForSession(handle: string, from: number, timeoutMs: number): Promise<IndexChangedMessage> {
    return this.#waitFor((message) => message.sessions.includes(handle), from, timeoutMs, `session ${handle}`);
  }

  #waitFor(
    matches: (message: IndexChangedMessage) => boolean,
    from: number,
    timeoutMs: number,
    what: string,
  ): Promise<IndexChangedMessage> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.messages.slice(from).find(matches);
        if (found === undefined) return;
        this.#waiters.delete(check);
        clearTimeout(timer);
        resolve(found);
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(check);
        reject(new Error(`no live message named ${what} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiters.add(check);
      check();
    });
  }

  close(): void {
    this.#socket.close();
  }
}

export class DashboardClient {
  readonly person: string;
  readonly #origin: string;
  readonly #cookie: string;

  private constructor(origin: string, person: string, sessionValue: string) {
    this.#origin = origin;
    this.person = person;
    this.#cookie = `${SESSION_COOKIE}=${sessionValue}`;
  }

  static async signIn(origin: string, person: "priya" | "jun", signIn: SignIn): Promise<DashboardClient> {
    const value =
      signIn.kind === "cookies" ? signIn.cookies[person] : await signInThroughDouble(origin, signIn.logins[person]);
    const client = new DashboardClient(origin, person, value);
    const session = await client.get("/api/session");
    if (session.owner !== person) throw new Error(`the ${person} session signs in as ${session.owner}`);
    return client;
  }

  async get(path: string): Promise<any> {
    const response = await fetch(`${this.#origin}${path}`, { headers: { Cookie: this.#cookie, Accept: "application/json" } });
    if (response.status !== 200) throw new Error(`GET ${path} answered HTTP ${response.status}`);
    return response.json();
  }

  /** A POST as the app sends it; returns the status with the body, since 4xx bodies carry outcomes. */
  async post(path: string, body: unknown): Promise<{ readonly status: number; readonly body: any }> {
    const response = await fetch(`${this.#origin}${path}`, {
      method: "POST",
      headers: { Cookie: this.#cookie, Origin: this.#origin, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  /** Opens /api/live and resolves once the socket is open. */
  openLive(): Promise<LiveSocket> {
    const url = `${this.#origin.replace(/^http/, "ws")}/api/live`;
    const socket = new WebSocket(url, { headers: { Cookie: this.#cookie, Origin: this.#origin } } as never);
    const live = new LiveSocket(socket);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(live), { once: true });
      socket.addEventListener("error", () => reject(new Error(`/api/live did not open for ${this.person}`)), { once: true });
    });
  }
}
