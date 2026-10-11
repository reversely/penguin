// The dashboard's route frame. The Worker serves index.html on exactly these paths (see
// PAGE_PATH in apps/worker/src/dashboard.ts) and redirects the former board at /board to /.

export type Route =
  /** The team map, or one person's view of it when `person` names them. */
  | { readonly page: "team"; readonly person: string | null }
  | { readonly page: "inbox"; readonly showAll: boolean }
  | { readonly page: "identities" }
  | { readonly page: "new-issue" }
  | { readonly page: "issue"; readonly issueId: string };

export type Page = Route["page"];

/** The inbox with every closed issue; it lists only the newest by default. */
export const INBOX_ALL_PATH = "/inbox?closed=all";

/** A person's view of the team map. */
export function personPath(person: string): string {
  return `/?person=${encodeURIComponent(person)}`;
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
  if (pathname === "/inbox") return { page: "inbox", showAll: query.get("closed") === "all" };
  if (pathname === "/identities") return { page: "identities" };
  // No issue takes this id: a number is digits and a temporary ID is an op_id, which has hyphens.
  if (pathname === "/issues/new") return { page: "new-issue" };
  const issueId = /^\/issues\/([A-Za-z0-9_-]+)$/.exec(pathname)?.[1];
  return issueId === undefined ? undefined : { page: "issue", issueId };
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
