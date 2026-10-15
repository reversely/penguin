// The `penguin-bridge identity create` and `penguin-bridge start approve` commands: what a person does
// on the dashboard's identities page and approve button, from their own bridge (#219). Each command is
// one request, signed with the owner's registered bridge key; Penguin accepts it only from an owner
// bridge acting for its own person and checks it as the dashboard routes do.

import { parseArgs } from "node:util";

import type { CliIo } from "./cli.ts";
import { loadSigningKey, type KeyStore } from "./key-store.ts";
import { openBridge, sendOwnerRequest, type Fetch } from "./penguin-client.ts";

export const OWNER_USAGE = `       penguin-bridge identity create --owner <id> --handle @<owner>/<name> --job <text> [--name <text>]
                      [--charter-scope <scope>]... [--charter-path <glob>]... [--auto-accept] [--state-dir <dir>]
       penguin-bridge start approve --owner <id> --feature <id|owner:<person>> --blocked <id> [--state-dir <dir>]
         Create one of your identities, or approve a start that waits for you, as the dashboard does.
         The request is signed with your registered bridge key.
`;

const IDENTITY_ROUTE = "/owner/identities";
const START_APPROVE_ROUTE = "/owner/starts/approve";

/** Runs `identity create` or `start approve`. Resolves with the exit code. */
export async function runOwnerCommand(
  command: "identity" | "start",
  args: readonly string[],
  io: CliIo,
  keyStore: KeyStore,
  defaultStateDir: string,
  fetchImpl?: Fetch,
): Promise<number> {
  const [action, ...rest] = args;
  let parsed: ReturnType<typeof parseOwnerArgs>;
  try {
    parsed = parseOwnerArgs(rest);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    io.write(`${error.message}\n${OWNER_USAGE}`);
    return 2;
  }
  const { values } = parsed;
  const request =
    command === "identity" && action === "create"
      ? identityRequest(values)
      : command === "start" && action === "approve"
        ? startRequest(values)
        : undefined;
  if (request === undefined || !values.owner) {
    io.write(OWNER_USAGE);
    return 2;
  }

  const { registration, bridgeToken } = await openBridge(values["state-dir"] ?? defaultStateDir, keyStore);
  if (registration.owner !== values.owner) {
    io.write(`This bridge is registered for ${registration.owner}, not ${values.owner}; it acts only for its own person.\n`);
    return 1;
  }
  const key = await loadSigningKey(keyStore, values.owner);
  const { status, body } = await sendOwnerRequest(registration.server, bridgeToken, values.owner, key.privateKey, request.route, request.fields, fetchImpl);
  if (status === 200 || status === 201) {
    io.write(request.done(body));
    return 0;
  }
  const message = typeof body["message"] === "string" ? `: ${body["message"]}` : "";
  io.write(`Penguin refused it (HTTP ${status})${message}\n`);
  return 1;
}

const parseOwnerArgs = (args: string[]) =>
  parseArgs({
    args,
    options: {
      owner: { type: "string" },
      handle: { type: "string" },
      name: { type: "string" },
      job: { type: "string" },
      "charter-scope": { type: "string", multiple: true },
      "charter-path": { type: "string", multiple: true },
      "auto-accept": { type: "boolean", default: false },
      feature: { type: "string" },
      blocked: { type: "string" },
      "state-dir": { type: "string" },
    },
    strict: true,
  });

type Values = ReturnType<typeof parseOwnerArgs>["values"];

interface OwnerRequest {
  readonly route: string;
  readonly fields: Record<string, unknown>;
  readonly done: (body: Record<string, unknown>) => string;
}

/** The identity the dashboard form would send. The name defaults to the handle's name. */
function identityRequest(values: Values): OwnerRequest | undefined {
  if (!values.handle || values.job === undefined) return undefined;
  const identity = {
    handle: values.handle,
    name: values.name ?? values.handle.slice(values.handle.indexOf("/") + 1),
    job: values.job,
    charterScopes: values["charter-scope"] ?? [],
    charterPaths: values["charter-path"] ?? [],
    autoAccept: values["auto-accept"],
  };
  return {
    route: IDENTITY_ROUTE,
    fields: { identity },
    done: (body) => `Created identity ${String(body["handle"])} (${String(body["id"])}).\n`,
  };
}

function startRequest(values: Values): OwnerRequest | undefined {
  if (!values.feature || !values.blocked) return undefined;
  const { feature, blocked } = values;
  return {
    route: START_APPROVE_ROUTE,
    fields: { feature, blockedFeature: blocked },
    done: () => `Approved the start of ${blocked} beside ${feature}.\n`,
  };
}
