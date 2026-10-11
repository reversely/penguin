export const packageName: string = "@penguin/mcp";

export { MCP_ROUTE, serveMcp } from "./handler.ts";
export {
  createPenguinMcpServer,
  type CharterView,
  type CheckpointResult,
  type FixTaskView,
  type McpProject,
  type McpRepos,
  type OperationView,
  type ReassignmentView,
  type Rejection,
  type SessionRegistration,
  type SessionResult,
  type SessionUpdate,
  type SessionView,
  type UpdateResult,
  type WorkResult,
} from "./tools.ts";
