/**
 * A minimal MCP client over Streamable HTTP: the JSON-RPC calls a coding agent's MCP client makes,
 * sent with plain fetch so the run needs no live agent. Penguin's /mcp is stateless, so every request
 * stands alone and carries the owner's token.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface ToolResult {
  /** The tool's structured result, or for an error, `{ error, message }`. */
  readonly value: Record<string, any>;
  readonly isError: boolean;
}

export class McpClient {
  readonly #endpoint: string;
  readonly #token: string;
  #nextId = 0;

  constructor(origin: string, token: string) {
    this.#endpoint = `${origin}/mcp`;
    this.#token = token;
  }

  /** Sends one JSON-RPC request and returns its `result`; a JSON-RPC error throws with its message. */
  async request(method: string, params: unknown = {}): Promise<any> {
    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#nextId, method, params }),
    });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`${method}: /mcp answered HTTP ${response.status}`);
    const message = parseMessage(text, response.headers.get("content-type") ?? "");
    if (message.error !== undefined) throw new Error(`${method}: ${message.error.message}`);
    return message.result;
  }

  /** What an agent does first: initialize and read the server's instructions. */
  initialize(): Promise<{ readonly serverInfo: { name: string }; readonly instructions?: string }> {
    return this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "penguin-e2e", version: "0.0.0" },
    });
  }

  async toolNames(): Promise<string[]> {
    const { tools } = await this.request("tools/list");
    return (tools as { name: string }[]).map((tool) => tool.name).sort();
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    return { value: result.structuredContent ?? {}, isError: result.isError === true };
  }
}

/** The one JSON-RPC message in a JSON body or in the `data:` line of an SSE body. */
function parseMessage(text: string, contentType: string): { result?: any; error?: { message: string } } {
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("the event stream held no message");
  return JSON.parse(data.slice("data: ".length));
}
