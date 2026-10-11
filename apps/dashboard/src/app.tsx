import { useCallback, useEffect, useState } from "react";

import { fetchSession, type Session } from "./api.ts";
import { BoardPage } from "./board-page.tsx";
import { InboxPage, useInbox } from "./inbox-page.tsx";
import { unreadCount } from "./inbox-view.ts";
import { IssuePageView } from "./issue-page.tsx";
import { linkHandler } from "./links.ts";
import { NAVIGATION, parseRoute, signInProblem, type Route, type SignInProblem } from "./routes.ts";
import { useLive, type LiveStatus } from "./use-live.ts";

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

function useRoute(): [Route | undefined, (path: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setRoute(parseRoute(path));
  }, []);
  return [route, navigate];
}

function Shell({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const [route, navigate] = useRoute();
  const live = useLive();
  // The shell holds the inbox, so the header's unread count and the inbox page read it once.
  const inbox = useInbox(live, onSignedOut);
  const unread = inbox.load.kind === "ready" ? unreadCount(inbox.load.items) : 0;

  return (
    <div className="shell">
      <header className="top-bar">
        <div className="top-bar-inner">
          <a className="brand" href="/" onClick={linkHandler(navigate, "/")}>
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
                {entry.page === "inbox" && unread > 0 ? (
                  <span className="count" aria-label={`${unread} unread`}>
                    {unread}
                  </span>
                ) : null}
              </a>
            ))}
          </nav>
          <div className="account">
            <LiveTag status={live.status} />
            <span className="owner" title={`GitHub ${session.login}`}>
              {session.owner}
            </span>
            <form method="post" action="/auth/signout">
              <button type="submit" className="button">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className={route?.page === "board" ? "page page-wide" : "page"} data-audit-center>
        {route?.page === "issue" ? (
          <IssuePageView key={route.issueId} issueId={route.issueId} live={live} navigate={navigate} onSignedOut={onSignedOut} />
        ) : route?.page === "board" ? (
          <BoardPage viewer={session.owner} live={live} navigate={navigate} onSignedOut={onSignedOut} />
        ) : route?.page === "inbox" ? (
          <InboxPage inbox={inbox} navigate={navigate} />
        ) : (
          <h1>{pageTitle(route)}</h1>
        )}
      </main>
    </div>
  );
}

function LiveTag({ status }: { status: LiveStatus }) {
  return (
    <span className={`tag tag-${status}`} role="status">
      {status}
    </span>
  );
}

function pageTitle(route: Route | undefined): string {
  if (route === undefined) return "Page not found";
  return NAVIGATION.find((entry) => entry.page === route.page)?.label ?? "";
}
