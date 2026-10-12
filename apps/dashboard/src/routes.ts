// The dashboard's route frame, which follows the hierarchy (PRD 0.5 core concepts): org, team, person,
// feature. The Worker serves index.html on exactly these paths (see PAGE_PATH in
// apps/worker/src/dashboard.ts) and redirects the former board at /board to /.

export type Route =
  /** Every team with its lead, its features by stage, what waits and its scopes' health. */
  | { readonly page: "org" }
  /** One team's members and scopes; null opens the signed-in person's own team, the home page. */
  | { readonly page: "team"; readonly team: string | null }
  /** One person's features, what waits on them and the scopes they are DRI for. */
  | { readonly page: "person"; readonly person: string }
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

/** The org page. */
export const ORG_PATH = "/org";

/** A team's page. A team id is lowercase letters, digits and hyphens, or `person:<id>` for a one-person team. */
export function teamPath(team: string): string {
  return `/teams/${team.split(":").map(encodeURIComponent).join(":")}`;
}

/** A person's page. */
export function personPath(person: string): string {
  return `/people/${encodeURIComponent(person)}`;
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
  // A history entry from before the board was retired, or from before people had their own path, still opens.
  if (pathname === "/" || pathname === "/board") {
    const person = query.get("person");
    return person ? { page: "person", person } : { page: "team", team: null };
  }
  if (pathname === ORG_PATH) return { page: "org" };
  const team = /^\/teams\/((?:person:)?[a-z0-9-]{1,64})$/.exec(pathname)?.[1];
  if (team !== undefined) return { page: "team", team };
  const person = /^\/people\/([a-z0-9-]{1,64})$/.exec(pathname)?.[1];
  if (person !== undefined) return { page: "person", person };
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
  { page: "org", path: ORG_PATH, label: "Org" },
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
