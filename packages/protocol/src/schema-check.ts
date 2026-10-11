// A checker for the subset of JSON Schema (draft 2020-12) that Penguin's own schemas use. It exists
// because no JSON Schema library is an approved dependency. A keyword outside the subset throws, so a
// schema can never silently pass data that a full validator would reject.

export type JsonSchema = { readonly [keyword: string]: unknown };

export interface SchemaError {
  /** JSON Pointer to the offending value, "" for the root. */
  readonly path: string;
  readonly message: string;
}

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "$defs", "title", "description", "examples"]);

const SUPPORTED = new Set([
  ...ANNOTATIONS,
  "$ref",
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
]);

export function checkSchema(root: JsonSchema, value: unknown): SchemaError[] {
  const errors: SchemaError[] = [];
  check(root, root, value, "", errors);
  return errors;
}

function check(root: JsonSchema, schema: JsonSchema, value: unknown, path: string, errors: SchemaError[]): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`unsupported schema keyword: ${keyword}`);
  }
  const fail = (message: string): void => {
    errors.push({ path, message });
  };

  if (typeof schema.$ref === "string") {
    check(root, resolveRef(root, schema.$ref), value, path, errors);
  }
  if (typeof schema.type === "string" && !hasType(value, schema.type)) {
    fail(`must be of type ${schema.type}`);
    return;
  }
  if ("const" in schema && !jsonEqual(value, schema.const)) fail(`must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => jsonEqual(value, option))) {
    fail(`must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
  }

  if (typeof value === "string") checkString(schema, value, fail);
  if (typeof value === "number") checkNumber(schema, value, fail);
  if (Array.isArray(value)) checkArray(root, schema, value, path, errors, fail);
  else if (isObject(value)) checkObject(root, schema, value, path, errors, fail);

  checkCombinators(root, schema, value, path, errors, fail);
}

function checkString(schema: JsonSchema, value: string, fail: (message: string) => void): void {
  // JSON Schema counts string length in code points, not UTF-16 units.
  const length = [...value].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    fail(`must be at least ${schema.minLength} characters`);
  }
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    fail(`must be at most ${schema.maxLength} characters`);
  }
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
    fail(`must match ${schema.pattern}`);
  }
}

function checkNumber(schema: JsonSchema, value: number, fail: (message: string) => void): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) fail(`must be at least ${schema.minimum}`);
  if (typeof schema.maximum === "number" && value > schema.maximum) fail(`must be at most ${schema.maximum}`);
}

function checkArray(
  root: JsonSchema,
  schema: JsonSchema,
  value: readonly unknown[],
  path: string,
  errors: SchemaError[],
  fail: (message: string) => void,
): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    fail(`must have at least ${schema.minItems} items`);
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    fail(`must have at most ${schema.maxItems} items`);
  }
  if (schema.uniqueItems === true) {
    const seen = new Set(value.map((item) => JSON.stringify(item)));
    if (seen.size !== value.length) fail("must not contain duplicate items");
  }
  if (isObject(schema.items)) {
    const items = schema.items as JsonSchema;
    value.forEach((item, index) => check(root, items, item, `${path}/${index}`, errors));
  }
}

function checkObject(
  root: JsonSchema,
  schema: JsonSchema,
  value: Readonly<Record<string, unknown>>,
  path: string,
  errors: SchemaError[],
  fail: (message: string) => void,
): void {
  const properties = isObject(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
  const keys = Object.keys(value);
  if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
    fail(`must have at least ${schema.minProperties} properties`);
  }
  if (Array.isArray(schema.required)) {
    for (const name of schema.required as string[]) {
      if (!Object.hasOwn(value, name)) fail(`must have property ${name}`);
    }
  }
  for (const key of keys) {
    const childPath = `${path}/${escapePointer(key)}`;
    if (Object.hasOwn(properties, key)) {
      check(root, properties[key], value[key], childPath, errors);
    } else if (schema.additionalProperties === false) {
      errors.push({ path: childPath, message: "is not an allowed property" });
    }
  }
}

function checkCombinators(
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: SchemaError[],
  fail: (message: string) => void,
): void {
  const passes = (sub: JsonSchema): boolean => checkSchemaAt(root, sub, value, path).length === 0;

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as JsonSchema[]) check(root, sub, value, path, errors);
  }
  if (Array.isArray(schema.anyOf) && !(schema.anyOf as JsonSchema[]).some(passes)) {
    fail("must match at least one allowed form");
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as JsonSchema[]).filter(passes).length;
    if (matches !== 1) fail(matches === 0 ? "must match one allowed form" : "matches more than one allowed form");
  }
  if (isObject(schema.not) && passes(schema.not as JsonSchema)) fail("must not match a disallowed form");
  if (isObject(schema.if) && isObject(schema.then) && passes(schema.if as JsonSchema)) {
    check(root, schema.then as JsonSchema, value, path, errors);
  }
}

function checkSchemaAt(root: JsonSchema, schema: JsonSchema, value: unknown, path: string): SchemaError[] {
  const errors: SchemaError[] = [];
  check(root, schema, value, path, errors);
  return errors;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  const prefix = "#/$defs/";
  const defs = root.$defs as Record<string, JsonSchema> | undefined;
  const name = ref.slice(prefix.length);
  if (!ref.startsWith(prefix) || defs === undefined || !Object.hasOwn(defs, name)) {
    throw new Error(`unresolvable $ref: ${ref}`);
  }
  return defs[name];
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      throw new Error(`unsupported schema type: ${type}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}
