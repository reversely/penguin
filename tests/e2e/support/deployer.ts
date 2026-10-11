/**
 * The deployer's routes the run needs: MCP tokens (K3) for each owner, a registration code for the
 * runner's bridge, and revoking both afterwards. The deployer token travels only in the Authorization
 * header, and an issued token is returned to the caller and never logged.
 */

export interface IssuedToken {
  readonly tokenId: string;
  readonly owner: string;
  readonly token: string;
}

export class Deployer {
  readonly #origin: string;
  readonly #token: string;

  constructor(origin: string, token: string) {
    this.#origin = origin;
    this.#token = token;
  }

  async #send(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.#origin}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Runs project setup (idempotent) and returns its report, which carries no token. */
  async setUp(owners: readonly string[]): Promise<{ complete: boolean; repos: { name: string; role: string; status: string }[] }> {
    const response = await this.#send("POST", "/setup", { owners });
    if (response.status !== 200) throw new Error(`/setup answered HTTP ${response.status}: ${await response.text()}`);
    return response.json() as never;
  }

  async issueMcpToken(owner: string): Promise<IssuedToken> {
    const response = await this.#send("POST", "/mcp/tokens", { owner });
    if (response.status !== 201) throw new Error(`/mcp/tokens answered HTTP ${response.status} for ${owner}`);
    const { tokenId, token } = (await response.json()) as { tokenId: string; token: string };
    return { tokenId, owner, token };
  }

  async revokeMcpToken(tokenId: string): Promise<void> {
    const response = await this.#send("DELETE", `/mcp/tokens/${tokenId}`);
    if (response.status !== 204) throw new Error(`revoking MCP token ${tokenId} answered HTTP ${response.status}`);
  }

  async bridgeCode(owner: string, role: "owner" | "runner"): Promise<string> {
    const response = await this.#send("POST", "/bridges/codes", { owner, role });
    if (response.status !== 201) throw new Error(`/bridges/codes answered HTTP ${response.status}`);
    return ((await response.json()) as { code: string }).code;
  }

  async revokeBridge(bridgeId: string): Promise<void> {
    const response = await this.#send("DELETE", `/bridges/${bridgeId}`);
    if (response.status !== 204) throw new Error(`revoking bridge ${bridgeId} answered HTTP ${response.status}`);
  }
}
