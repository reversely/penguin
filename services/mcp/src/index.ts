export const packageName: string = "@penguin/mcp";

export { MCP_ROUTE, serveMcp } from "./handler.ts";
export {
  createPenguinMcpServer,
  type CharterView,
  type McpProject,
  type OperationView,
  type Rejection,
  type SessionRegistration,
  type SessionResult,
  type SessionView,
  type WorkResult,
} from "./tools.ts";
