// What every page knows of an agent by its handle, from GET /api/identities as the shell reads it: its
// identity id, its upload and its person. A label for a handle outside the page names the person its
// handle's "@owner/" half names. `Agent` renders the shared label with those facts.

import type { IdentitiesPage } from "@penguin/protocol";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { AgentLabel } from "./agent-label.tsx";
import { linkHandler } from "./links.ts";
import { handleOwner } from "./penguin-face.ts";
import { identityPath } from "./routes.ts";

export interface AgentInfo {
  readonly id: string | null;
  readonly image: string | null;
  readonly person: string;
}

const Directory = createContext<ReadonlyMap<string, AgentInfo>>(new Map());

/** Gives every `Agent` below it the identities the page read. */
export function AgentDirectory({ page, children }: { readonly page: IdentitiesPage | undefined; readonly children: ReactNode }) {
  const known = useMemo(
    () => new Map((page?.identities ?? []).map((identity) => [identity.handle, { id: identity.id, image: identity.avatar, person: identity.owners[0] ?? "" }])),
    [page],
  );
  return <Directory.Provider value={known}>{children}</Directory.Provider>;
}

export function useAgentInfo(handle: string, person?: string): AgentInfo {
  const known = useContext(Directory).get(handle);
  return { id: known?.id ?? null, image: known?.image ?? null, person: person ?? known?.person ?? handleOwner(handle) };
}

interface AgentProps {
  readonly handle: string;
  /** The agent's person when the answer names it; else the identities page's, else the handle's. */
  readonly person?: string;
  readonly variant?: "full" | "compact";
  readonly online?: boolean;
  /** With `navigate`, the label opens the agent's card. */
  readonly navigate?: (path: string) => void;
}

/** One agent's shared label, opening its agent card when the identity is known and `navigate` is given. */
export function Agent({ handle, person, variant = "full", online = false, navigate }: AgentProps) {
  const info = useAgentInfo(handle, person);
  const label = <AgentLabel handle={handle} image={info.image} person={info.person} variant={variant} online={online} />;
  if (navigate === undefined || info.id === null) return label;
  const path = identityPath(info.id);
  return (
    <a className="agent-link" href={path} onClick={linkHandler(navigate, path)}>
      {label}
    </a>
  );
}
