// How every surface outside the agent card names an agent: its name, the second half of its handle,
// beside its character, and its person. The character sits in a ring of the person's hue, so two
// people's agents with the same name read apart. The full handle, the vendor and the branch appear on
// the agent card only. The full label puts the person on a second line; the compact label is one
// line for dense rows. Every value renders as React text.

import { IdentityAvatar, usePersonHue, type AvatarSize } from "./avatar.tsx";

/** The agent's name: the handle's part after "@owner/", or the handle without its "@" when it has none. */
export function agentName(handle: string): string {
  const slash = handle.indexOf("/");
  return slash === -1 ? handle.replace(/^@/, "") : handle.slice(slash + 1);
}

interface MarkProps {
  readonly handle: string;
  readonly image: string | null;
  readonly person: string;
  readonly size: AvatarSize;
  /** Draws the online dot on the character while a session of the agent runs. */
  readonly online?: boolean;
}

/** An agent's character, or its upload, in a ring of its person's hue. */
export function AgentMark({ handle, image, person, size, online = false }: MarkProps) {
  const hue = usePersonHue(person);
  return (
    <span className={`agent-mark agent-mark-${size} person-${hue}`}>
      <IdentityAvatar handle={handle} image={image} size={size} />
      {online ? <span className="online-dot" /> : null}
    </span>
  );
}

interface LabelProps {
  readonly handle: string;
  readonly image: string | null;
  readonly person: string;
  /** The person as text when it differs from the one whose hue rings the character, such as a team identity's owners. */
  readonly personText?: string;
  readonly variant?: "full" | "compact";
  readonly online?: boolean;
}

/** An agent's name beside its character, with its person on a second line or, compact, after it. */
export function AgentLabel({ handle, image, person, personText = person, variant = "full", online = false }: LabelProps) {
  const name = agentName(handle);
  return (
    <span className={variant === "compact" ? "agent-label agent-label-compact" : "agent-label"}>
      <AgentMark handle={handle} image={image} person={person} size={variant === "compact" ? "card" : "row"} online={online} />
      <span className="agent-label-text">
        <span className="agent-label-name">{name}</span>
        <span className="agent-label-person">{personText}</span>
      </span>
      {online ? <span className="visually-hidden">running</span> : null}
    </span>
  );
}
