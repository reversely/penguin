export const packageName: string = "@penguin/protocol";

export * from "./operation-schema.ts";
export * from "./operation.ts";
export { checkSchema, type JsonSchema, type SchemaError } from "./schema-check.ts";
export {
  compareWithinCommit,
  coordinationOrder,
  readBaseVersion,
  type OperationCommit,
  type OperationFileRef,
} from "./order.ts";
