// `penguin/teams.json`, beside `penguin/scopes.json` in the base repo (PRD 0.5 core concepts and
// section 9, `Team(id, name, lead_id, member_ids)`). A team owns scopes, as CODEOWNERS assigns code to
// teams; each scope names its team, its DRI and its fallback order (index.ts).
//
// A repo without the file has no declared teams. A scope that names only an `owner` reads as a
// one-person team, `person:<owner>`, so repos written before teams keep working; a declared team id
// is a lowercase slug, so it never collides with one of those.

/** A group of people with a lead. The lead need not be a member. */
export interface Team {
  readonly id: string;
  readonly name: string;
  readonly leadId: string;
  /** Sorted, without duplicates. */
  readonly memberIds: readonly string[];
  /** True for the one-person team a scope with only an `owner` stands for. */
  readonly implicit: boolean;
}

export const TEAMS_PATH = "penguin/teams.json";

export const TEAM_LIMITS = { teams: 256, members: 256, idLength: 64, nameLength: 128 } as const;

/** A declared team id: lowercase letters, digits and hyphens. */
const TEAM_ID = /^[a-z0-9][a-z0-9-]*$/u;

/** The id of the one-person team a scope with only `owner` stands for. */
export function personTeamId(owner: string): string {
  return `person:${owner}`;
}

/** The one-person team of `owner`: its lead and only member. */
export function personTeam(owner: string): Team {
  return { id: personTeamId(owner), name: owner, leadId: owner, memberIds: [owner], implicit: true };
}

/** One problem found in a teams file, with the JSON field it concerns. */
export interface TeamsIssue {
  readonly field: string;
  readonly message: string;
}

/** A teams file that failed validation. `issues` lists every problem found. */
export class TeamsError extends Error {
  readonly issues: readonly TeamsIssue[];

  constructor(issues: readonly TeamsIssue[]) {
    super(`invalid ${TEAMS_PATH}:\n` + issues.map((issue) => `  ${issue.field}: ${issue.message}`).join("\n"));
    this.name = "TeamsError";
    this.issues = issues;
  }
}

export interface ParseTeamsOptions {
  /** Person ids from `penguin/owners.json`. When given, every lead and member must be one of them. */
  readonly ownerIds?: Iterable<string>;
}

const isPerson = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Validate the parsed contents of `penguin/teams.json`: `{ "teams": [{ id, name, lead, members }] }`.
 *
 * Raises:
 *   TeamsError: listing every invalid field, including a duplicate team id, an empty or repeated
 *   member, and, with `ownerIds`, a lead or member who is not a known person.
 */
export function parseTeams(json: unknown, options: ParseTeamsOptions = {}): ReadonlyMap<string, Team> {
  const issues: TeamsIssue[] = [];
  const report = (field: string, message: string): void => {
    issues.push({ field, message });
  };
  const raw = typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>).teams : undefined;
  if (!Array.isArray(raw) || raw.length > TEAM_LIMITS.teams) {
    report("teams", `must be an array of at most ${TEAM_LIMITS.teams} team objects`);
    throw new TeamsError(issues);
  }
  const known = options.ownerIds === undefined ? undefined : new Set(options.ownerIds);
  const person = (field: string, value: unknown): value is string => {
    if (!isPerson(value)) report(field, "must be a person id");
    else if (known !== undefined && !known.has(value)) report(field, `names unknown person "${value}"`);
    else return true;
    return false;
  };
  const teams = new Map<string, Team>();
  raw.forEach((entry: unknown, index) => {
    const at = `teams[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      report(at, "must be an object with id, name, lead and members");
      return;
    }
    const { id, name, lead, members } = entry as Record<string, unknown>;
    const idOk = typeof id === "string" && id.length <= TEAM_LIMITS.idLength && TEAM_ID.test(id);
    if (!idOk) report(`${at}.id`, `must be lowercase letters, digits and hyphens, at most ${TEAM_LIMITS.idLength} characters`);
    else if (teams.has(id)) report(`${at}.id`, `duplicate team id "${id}"`);
    const nameOk = typeof name === "string" && name.trim().length > 0 && name.length <= TEAM_LIMITS.nameLength;
    if (!nameOk) report(`${at}.name`, `must be a non-empty name of at most ${TEAM_LIMITS.nameLength} characters`);
    const leadOk = person(`${at}.lead`, lead);
    const memberIds = new Set<string>();
    if (!Array.isArray(members) || members.length === 0 || members.length > TEAM_LIMITS.members) {
      report(`${at}.members`, `must be a non-empty array of at most ${TEAM_LIMITS.members} person ids`);
    } else {
      members.forEach((member: unknown, memberIndex) => {
        const field = `${at}.members[${memberIndex}]`;
        if (!person(field, member)) return;
        if (memberIds.has(member)) report(field, `repeats "${member}"`);
        memberIds.add(member);
      });
    }
    if (idOk && !teams.has(id) && nameOk && leadOk) {
      teams.set(id, { id, name, leadId: lead, memberIds: [...memberIds].sort(), implicit: false });
    }
  });
  if (issues.length > 0) throw new TeamsError(issues);
  return teams;
}
