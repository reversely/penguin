import { useCallback, useEffect, useState } from "react";

import { AccountMenu } from "./account-menu.tsx";
import { Banners } from "./banner.tsx";
import { fetchSession, type Session } from "./api.ts";
import { DetailsPane, DetailsProvider, useDetails } from "./details-pane.tsx";
import { FeaturePageView } from "./feature-page.tsx";
import { IdentitiesPageView } from "./identities-page.tsx";
import { approvalCount, useApprovals, type ApprovalsState } from "./approvals.tsx";
import { InboxPage, InboxSidebar, useInbox } from "./inbox-page.tsx";
import { IssuePageView } from "./issue-page.tsx";
import { linkHandler } from "./links.ts";
import { NewIssuePage } from "./new-issue-page.tsx";
import { NAVIGATION, parseRoute, signInProblem, type Route, type SignInProblem } from "./routes.ts";
import { SidebarSlotProvider } from "./sidebar-slot.tsx";
import { TeamHues, TeamPage, useTeam, type Team } from "./team-page.tsx";
import { useLive, type Live } from "./use-live.ts";

type SessionState = { readonly kind: "loading" } | { readonly kind: "signed-out" } | { readonly kind: "signed-in"; readonly session: Session };

export function App() {
  const [state, setState] = useState<SessionState>({ kind: "loading" });
  const signedOut = useCallback(() => setState({ kind: "signed-out" }), []);

  useEffect(() => {
    fetchSession().then(
      (session) => setState(session === undefined ? { kind: "signed-out" } : { kind: "signed-in", session }),
      signedOut,
    );
  }, [signedOut]);

  if (state.kind === "loading") return <main className="page" aria-busy="true" />;
  if (state.kind === "signed-out") return <SignIn problem={signInProblem(window.location.search)} />;
  return <Shell session={state.session} onSignedOut={signedOut} />;
}

const PROBLEM_TEXT: Record<SignInProblem, string> = {
  "no-owner": "Please ask your Penguin admin to add your GitHub account",
  failed: "Please try signing in again",
};

function SignIn({ problem }: { problem: SignInProblem | undefined }) {
  return (
    <main className="sign-in">
      <section className="sign-in-card" data-audit-center>
        <h1>Penguin</h1>
        {problem === undefined ? null : (
          <p className="notice" role="alert">
            {PROBLEM_TEXT[problem]}
          </p>
        )}
        <a className="button primary" href="/auth/github">
          Sign in with GitHub
        </a>
      </section>
    </main>
  );
}

function currentRoute(): Route | undefined {
  return parseRoute(window.location.pathname, window.location.search);
}

function useRoute(): [Route | undefined, (path: string) => void] {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setRoute(currentRoute());
  }, []);
  return [route, navigate];
}

/**
 * The three-pane shell (identity plan section 4): the sidebar with the wordmark, the navigation, the
 * route's list and the signed-in owner; the centre pane; and the right panel for a page's details.
 * Below 760px the sidebar becomes the phone header. app.css switches the layouts; the markup and its
 * keyboard order stay the same in each.
 */
function Shell({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const [route, navigate] = useRoute();
  const live = useLive();
  // The shell holds the approvals, so the navigation's count and the inbox page read them once. The
  // issue items stay for the issue pages' sidebar list.
  const approvals = useApprovals(live, onSignedOut);
  const inbox = useInbox(live, onSignedOut);
  // The shell holds the team too, so the team map and every person's hue on any page come from one read.
  const team = useTeam(live, onSignedOut);
  const waiting = approvals.loaded ? approvalCount(approvals.approvals) : 0;
  const details = useDetails(route?.page === "issue" ? `issue:${route.issueId}` : (route?.page ?? ""));
  const covered = details.shown && !details.docked;
  // The sidebar's list slot, which a page fills through <SidebarList>.
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  return (
    <DetailsProvider value={details}>
      <TeamHues team={team}>
        <SidebarSlotProvider value={slot}>
          <div className="shell" data-details={details.shown && details.docked ? "docked" : undefined}>
            <header className="sidebar" inert={covered}>
              <a className="wordmark" href="/" onClick={linkHandler(navigate, "/")}>
                Penguin
              </a>
              <nav className="nav" aria-label="Main">
                {NAVIGATION.map((entry) => (
                  <a
                    key={entry.page}
                    href={entry.path}
                    className="nav-link"
                    aria-current={route?.page === entry.page ? "page" : undefined}
                    onClick={linkHandler(navigate, entry.path)}
                  >
                    {entry.label}
                    {entry.page === "inbox" && waiting > 0 ? (
                      <span className="count" aria-label={`${waiting} waiting`}>
                        {waiting}
                      </span>
                    ) : null}
                  </a>
                ))}
              </nav>
              {/* The route's list; on a route without one the space keeps the owner at the foot of the
                  sidebar. The issue rows belong to the shell, so they stay mounted, with their scroll,
                  from one open issue to the next. */}
              <div className="sidebar-list" ref={setSlot} />
              <InboxSidebar route={route} inbox={inbox} viewer={session.owner} live={live} navigate={navigate} onSignedOut={onSignedOut} />
              <AccountMenu session={session} status={live.status} />
            </header>
            <main className="centre" inert={covered}>
              <div className={route?.page === "team" && route.person === null ? "page page-wide" : "page"} data-audit-center>
                {approvals.loaded ? (
                  <Banners
                    approvals={approvals.approvals}
                    team={team.view.kind === "ready" ? team.view.value : undefined}
                    viewer={session.owner}
                    current={route?.page === "feature" ? route.featureId : null}
                    navigate={navigate}
                  />
                ) : null}
                <Page route={route} session={session} live={live} approvals={approvals} team={team} navigate={navigate} onSignedOut={onSignedOut} />
              </div>
            </main>
            <DetailsPane details={details} />
          </div>
        </SidebarSlotProvider>
      </TeamHues>
    </DetailsProvider>
  );
}

interface PageProps {
  readonly route: Route | undefined;
  readonly session: Session;
  readonly live: Live;
  readonly approvals: ApprovalsState;
  readonly team: Team;
  readonly navigate: (path: string) => void;
  readonly onSignedOut: () => void;
}

function Page({ route, session, live, approvals, team, navigate, onSignedOut }: PageProps) {
  if (route?.page === "issue") {
    return <IssuePageView key={route.issueId} issueId={route.issueId} viewer={session.owner} live={live} navigate={navigate} onSignedOut={onSignedOut} />;
  }
  if (route?.page === "team") {
    return <TeamPage team={team} person={route.person} navigate={navigate} />;
  }
  if (route?.page === "feature") {
    return <FeaturePageView key={route.featureId} featureId={route.featureId} viewer={session.owner} team={team.view.kind === "ready" ? team.view.value : undefined} live={live} navigate={navigate} onSignedOut={onSignedOut} />;
  }
  if (route?.page === "inbox") {
    return <InboxPage approvals={approvals} navigate={navigate} onSignedOut={onSignedOut} />;
  }
  if (route?.page === "new-issue") return <NewIssuePage live={live} navigate={navigate} onSignedOut={onSignedOut} />;
  if (route?.page === "identities") {
    return <IdentitiesPageView viewer={session.owner} live={live} navigate={navigate} onSignedOut={onSignedOut} />;
  }
  return <h1>{pageTitle(route)}</h1>;
}

function pageTitle(route: Route | undefined): string {
  if (route === undefined) return "Page not found";
  return NAVIGATION.find((entry) => entry.page === route.page)?.label ?? "";
}
