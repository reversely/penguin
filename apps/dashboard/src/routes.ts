// The dashboard's route frame. The Worker serves index.html on exactly these paths (see
// PAGE_PATH in apps/worker/src/dashboard.ts) and redirects the former board at /board to /.

export type Route =
  /** The team map, or one person's view of it when `person` names them. */
  | { readonly page: "team"; readonly person: string | null }
  | { readonly page: "inbox" }
  | { readonly page: "identities" }
  | { readonly page: "new-issue" }
  /** One feature's page: its declaration, merge plan, checks, tools and record. */
  | { readonly page: "feature"; readonly featureId: string }
  /** One issue, beside the issue list, whose Closed issues show every item when `showAll` holds. */
  | { readonly page: "issue"; readonly issueId: string; readonly showAll: boolean };

export type Page = Route["page"];

/** An issue with the issue list beside it showing every closed issue; it lists only the newest by default. */
export function issueAllPath(issueId: string): string {
  return `/issues/${encodeURIComponent(issueId)}?closed=all`;
}

/** A person's view of the team map. */
export function personPath(person: string): string {
  return `/?person=${encodeURIComponent(person)}`;
}

/** A feature's page. */
export function featurePath(featureId: string): string {
  return `/features/${encodeURIComponent(featureId)}`;
}

/** An identity's agent card on the identities page. */
export function identityPath(id: string | null): string {
  return id === null ? "/identities" : `/identities?identity=${encodeURIComponent(id)}`;
}

/** The route for a path and its query, or undefined for a path the dashboard does not serve. */
export function parseRoute(pathname: string, search = ""): Route | undefined {
  const query = new URLSearchParams(search);
  // A history entry from before the board was retired still opens the team map.
  if (pathname === "/" || pathname === "/board") return { page: "team", person: query.get("person") || null };
  if (pathname === "/inbox") return { page: "inbox" };
  if (pathname === "/identities") return { page: "identities" };
  // No issue takes this id: a number is digits and a temporary ID is an op_id, which has hyphens.
  if (pathname === "/issues/new") return { page: "new-issue" };
  // A feature id is lowercase letters and digits joined by single dots or hyphens.
  const featureId = /^\/features\/([a-z0-9.-]{1,63})$/.exec(pathname)?.[1];
  if (featureId !== undefined) return { page: "feature", featureId };
  const issueId = /^\/issues\/([A-Za-z0-9_-]+)$/.exec(pathname)?.[1];
  return issueId === undefined ? undefined : { page: "issue", issueId, showAll: query.get("closed") === "all" };
}

/** The navigation entries in the shell's header, in order. */
export const NAVIGATION: readonly { readonly page: Page; readonly path: string; readonly label: string }[] = [
  { page: "team", path: "/", label: "Team" },
  { page: "inbox", path: "/inbox", label: "Inbox" },
  { page: "identities", path: "/identities", label: "Identities" },
];

/** Why sign-in sent the person back, from the `signin` query parameter the Worker sets. */
export type SignInProblem = "no-owner" | "failed";

export function signInProblem(search: string): SignInProblem | undefined {
  const value = new URLSearchParams(search).get("signin");
  return value === "no-owner" || value === "failed" ? value : undefined;
}
