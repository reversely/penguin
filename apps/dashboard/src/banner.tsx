// The banners at the top of the signed-in person's pages (#125): one line per colleague's feature that
// reaches their scopes or running features, naming the colleague, the feature and its current stage,
// linking to the change page. A banner that needs the person says so. Every value renders as text.

import type { TeamView } from "@penguin/protocol";

import type { Approvals } from "./approvals.tsx";
import { PersonAvatar } from "./avatar.tsx";
import { colleagueBanners } from "./banner-view.ts";
import { linkHandler } from "./links.ts";
import { currentStageText } from "./pipeline-view.ts";

interface Props {
  readonly approvals: Approvals;
  readonly team: TeamView | undefined;
  readonly viewer: string;
  /** The feature whose page is open, which needs no banner of its own. */
  readonly current: string | null;
  readonly navigate: (path: string) => void;
}

export function Banners({ approvals, team, viewer, current, navigate }: Props) {
  const banners = colleagueBanners(approvals, team, viewer).filter((banner) => banner.feature !== current);
  if (banners.length === 0) return null;
  const strips = new Map(team?.people.flatMap((person) => person.features.map((feature) => [feature.id, feature.strip] as const)) ?? []);
  return (
    <ul className="banners" aria-label="Colleagues' changes">
      {banners.map((banner) => {
        const strip = strips.get(banner.feature);
        return (
          <li key={banner.feature} className="banner" data-needs-you={banner.needsYou ? true : undefined}>
            <span className="approval-person">
              <PersonAvatar id={banner.person} size="card" />
              {banner.person}
            </span>
            <a className="banner-link" href={banner.path} onClick={linkHandler(navigate, banner.path)}>
              {banner.feature}
            </a>
            {strip === undefined ? null : <span className="muted">{currentStageText(strip)}</span>}
            {banner.needsYou ? <span className="tag tag-attention">Needs you</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
