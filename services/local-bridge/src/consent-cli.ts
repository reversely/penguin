// The `penguin-bridge consent list|revoke` commands over the bridge's stored publishing consent.

import { parseArgs } from "node:util";

import type { CliIo } from "./cli.ts";
import { bridgeConsent, type ConsentGrant } from "./consent-store.ts";
import { worktreeAt } from "./session-checkpoint.ts";

export const CONSENT_USAGE = `       penguin-bridge consent list [--state-dir <dir>]
       penguin-bridge consent revoke [--worktree <path> | --all] [--state-dir <dir>]
`;

function describe(grant: ConsentGrant): string {
  const reach = grant.worktree_id === null ? "every worktree" : `${grant.worktree_path} (${grant.worktree_id})`;
  return `${reach} -> ${grant.fork} for ${grant.owner_id} in ${grant.project_id}, since ${grant.granted_at}\n`;
}

/**
 * Runs `consent list` (print every standing yes) or `consent revoke` (withdraw the yes for the
 * worktree it runs in, `--worktree <path>`, or with `--all` every yes). Resolves with the exit code.
 */
export async function runConsentCommand(args: readonly string[], io: CliIo, stateDir: string): Promise<number> {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      "state-dir": { type: "string" },
      worktree: { type: "string" },
      all: { type: "boolean", default: false },
    },
    strict: true,
  });
  const store = bridgeConsent(values["state-dir"] ?? stateDir);
  if (command === "list" && values.worktree === undefined && !values.all) {
    const grants = await store.list();
    io.write(grants.length === 0 ? "No standing consent. Every publish asks.\n" : grants.map(describe).join(""));
    return 0;
  }
  if (command === "revoke" && !(values.all && values.worktree !== undefined)) {
    const filter = values.all ? {} : { worktree_id: (await worktreeAt(values.worktree ?? process.cwd())).id };
    const removed = await store.revoke(filter);
    io.write(`Revoked ${removed} standing consent${removed === 1 ? "" : "s"}. The next publish asks again.\n`);
    return 0;
  }
  io.write(CONSENT_USAGE);
  return 2;
}
