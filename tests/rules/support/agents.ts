// The `agents` package's Agent base class, as far as the ProjectAgent's runner routes use it, so the
// real ProjectAgent runs under Node with SQLite storage (binding-calls.test.ts). Durable Object RPC
// becomes a plain method call: `getAgentByName` answers the namespace's own instance.

export interface AgentStorage {
  readonly sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(body: () => T): T;
}

export class Agent {
  readonly ctx: { readonly storage: AgentStorage };
  readonly env: unknown;
  readonly name = "project";

  constructor(ctx: { readonly storage: AgentStorage }, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }

  sql(strings: TemplateStringsArray, ...values: unknown[]): Record<string, unknown>[] {
    return this.ctx.storage.sql.exec(strings.join("?"), ...values).toArray();
  }

  getConnections(): never[] {
    return [];
  }

  broadcast(): void {}

  async schedule(): Promise<void> {}
}

export async function getAgentByName<T>(namespace: { get(name: string): T }, name: string): Promise<T> {
  return namespace.get(name);
}

export async function routeAgentRequest(): Promise<null> {
  return null;
}
