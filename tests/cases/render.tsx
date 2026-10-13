// Renders the dashboard's feature page and inbox to HTML on the server, as the browser would show them
// with every stage, review, check and part open, so a use-case test reads what a person sees. The test
// bundles this file with esbuild, since Node runs TypeScript but not JSX.

import type { FeaturePage, PlanInbox } from "@penguin/protocol";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalsView } from "../../apps/dashboard/src/approvals.tsx";
import { FeatureView } from "../../apps/dashboard/src/feature-page.tsx";
import { stageAnchor, type View } from "../../apps/dashboard/src/page-view.ts";
import { partAnchor } from "../../apps/dashboard/src/pipeline-view.ts";

const ignore = () => undefined;

/** One view of the feature page with every fold open. */
export function featureHtml(page: FeaturePage, viewer: string, view: View): string {
  const open = [...page.pipeline.stages.map((stage) => stageAnchor(stage.key)), "reviews", "checks", ...(page.plan?.parts ?? []).map((part) => partAnchor(part.partId))];
  return renderToStaticMarkup(<FeatureView page={page} viewer={viewer} navigate={ignore} open={open} view={view} />);
}

/** The approvals inbox of a person, as their plan parts and review exceptions read. */
export function inboxHtml(plan: PlanInbox): string {
  return renderToStaticMarkup(<ApprovalsView approvals={{ overlaps: [], plan }} busy={undefined} failed={false} navigate={ignore} onApproveStart={ignore} onDecide={ignore} />);
}
