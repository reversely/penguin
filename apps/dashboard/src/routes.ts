// The dashboard's route frame. The Worker serves index.html on exactly these paths (see
// PAGE_PATH in apps/worker/src/dashboard.ts); the pages themselves are built by later tickets.

export type Route =
  | { readonly page: "inbox" }
  | { readonly page: "board" }
  | { readonly page: "identities" }
  | { readonly page: "new-issue" }
  | { readonly page: "issue"; readonly issueId: string };

export type Page = Route["page"];

/** The route for a path, or undefined for a path the dashboard does not serve. */
export function parseRoute(pathname: string): Route | undefined {
  if (pathname === "/" || pathname === "/inbox") return { page: "inbox" };
  if (pathname === "/board") return { page: "board" };
  if (pathname === "/identities") return { page: "identities" };
  // No issue takes this id: a number is digits and a temporary ID is an op_id, which has hyphens.
  if (pathname === "/issues/new") return { page: "new-issue" };
  const issueId = /^\/issues\/([A-Za-z0-9_-]+)$/.exec(pathname)?.[1];
  return issueId === undefined ? undefined : { page: "issue", issueId };
}

/** The navigation entries in the shell's header, in order. */
export const NAVIGATION: readonly { readonly page: Page; readonly path: string; readonly label: string }[] = [
  { page: "inbox", path: "/inbox", label: "Inbox" },
  { page: "board", path: "/board", label: "Board" },
  { page: "identities", path: "/identities", label: "Identities" },
];

/** Why sign-in sent the person back, from the `signin` query parameter the Worker sets. */
export type SignInProblem = "no-owner" | "failed";

export function signInProblem(search: string): SignInProblem | undefined {
  const value = new URLSearchParams(search).get("signin");
  return value === "no-owner" || value === "failed" ? value : undefined;
}
