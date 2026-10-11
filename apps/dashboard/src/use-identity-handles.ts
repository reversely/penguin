// The identity handles a person can assign, with each identity's id and uploaded avatar, read from
// GET /api/identities and again whenever an identity is created, edited or duplicated.

import { useEffect, useState } from "react";

import { fetchIdentities, SignedOut } from "./api.ts";
import type { Live } from "./use-live.ts";

/** What the dashboard knows of each identity by handle: its id and its uploaded avatar as a `data:` URL, or null. */
export type KnownIdentities = ReadonlyMap<string, { readonly id: string; readonly avatar: string | null }>;

export type IdentityHandles =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "ready";
      readonly handles: readonly string[];
      /** Each identity's id, which its agent card's link names, and uploaded avatar, by handle. */
      readonly known: KnownIdentities;
    };

export function useIdentityHandles(live: Live, onSignedOut: () => void): IdentityHandles {
  const [handles, setHandles] = useState<IdentityHandles>({ kind: "loading" });
  const connected = live.status === "live";

  useEffect(() => {
    let current = true;
    fetchIdentities().then(
      (page) => {
        if (current) {
          setHandles({
            kind: "ready",
            handles: page.identities.map((identity) => identity.handle),
            known: new Map(page.identities.map((identity) => [identity.handle, { id: identity.id, avatar: identity.avatar }])),
          });
        }
      },
      (error: unknown) => {
        if (error instanceof SignedOut) onSignedOut();
        // A failed refresh keeps the handles already read.
        else if (current) setHandles((previous) => (previous.kind === "ready" ? previous : { kind: "failed" }));
      },
    );
    return () => {
      current = false;
    };
    // `connected` reads the handles again after a reconnect, which may have missed a change.
  }, [live.identitiesRevision, connected, onSignedOut]);

  return handles;
}
