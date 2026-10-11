// What the identities page derives from GET /api/identities and its form: who may edit an identity,
// which scopes its charter may name, and the request body each form sends. Pure, so the rules are
// tested without a browser (test/identities-view.test.ts).
//
// The page only offers what the ProjectAgent would accept: edit and duplicate controls on the
// signed-in person's own identities, and charter scopes of the identity's owners. The ProjectAgent
// still checks every write.

import { IDENTITY_HANDLE_MAX_LENGTH, type IdentityEntry, type IdentityLimits, type IdentityScope } from "@penguin/protocol";

export type FormKind = "create" | "edit" | "duplicate";

/** An avatar the form holds: the identity's current one (`data` null) or a newly chosen image. */
export interface FormAvatar {
  readonly url: string;
  readonly mediaType: string;
  /** The new image as base64, or null for the identity's current avatar. */
  readonly data: string | null;
}

export interface IdentityForm {
  readonly kind: FormKind;
  /** The identity being edited or duplicated; null when creating. */
  readonly sourceId: string | null;
  /** The handle of the identity being edited or duplicated; null when creating. */
  readonly sourceHandle: string | null;
  /** The handle's name half: the part after "@<owner>/". */
  readonly handleName: string;
  readonly name: string;
  readonly avatar: FormAvatar | null;
  readonly job: string;
  readonly team: boolean;
  /** A team identity's owners, the signed-in person among them. */
  readonly owners: readonly string[];
  readonly charterScopes: readonly string[];
  /** Charter paths, one per line. */
  readonly paths: string;
  /** Charter rules, one per line. */
  readonly rules: string;
  readonly autoAccept: boolean;
}

export const AVATAR_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The handle's name half: lowercase letters and digits joined by single hyphens. */
export const HANDLE_NAME_PATTERN = "[a-z0-9]+(-[a-z0-9]+)*";

/** Whether the signed-in person owns the identity, and so may edit or duplicate it. */
export function canEdit(identity: IdentityEntry, viewer: string): boolean {
  return identity.owners.includes(viewer);
}

/** The scopes a charter may name: those whose owner is one of the identity's owners. */
export function scopeChoices(scopes: readonly IdentityScope[], owners: readonly string[]): IdentityScope[] {
  return scopes.filter((scope) => owners.includes(scope.ownerId));
}

/** The longest name half a handle of `viewer` may have. */
export function handleNameMaxLength(viewer: string): number {
  return IDENTITY_HANDLE_MAX_LENGTH - `@${viewer}/`.length;
}

export function blankForm(viewer: string): IdentityForm {
  return {
    kind: "create",
    sourceId: null,
    sourceHandle: null,
    handleName: "",
    name: "",
    avatar: null,
    job: "",
    team: false,
    owners: [viewer],
    charterScopes: [],
    paths: "",
    rules: "",
    autoAccept: false,
  };
}

/** The form to edit an identity, or to duplicate it under a free handle of the signed-in person. */
export function formFor(identity: IdentityEntry, kind: "edit" | "duplicate", viewer: string, taken: ReadonlySet<string>): IdentityForm {
  return {
    kind,
    sourceId: identity.id,
    sourceHandle: identity.handle,
    handleName: kind === "edit" ? handleNameOf(identity.handle) : copyName(handleNameOf(identity.handle), viewer, taken),
    name: identity.name,
    avatar: identity.avatar === null ? null : { url: identity.avatar, mediaType: "", data: null },
    job: identity.job,
    team: identity.team,
    owners: identity.owners,
    charterScopes: identity.charterScopes,
    paths: identity.charterPaths.join("\n"),
    rules: identity.charterRules.join("\n"),
    autoAccept: identity.autoAccept,
  };
}

function handleNameOf(handle: string): string {
  return handle.slice(handle.indexOf("/") + 1);
}

/** "<name>-copy", or "<name>-copy-2" and on, the first the signed-in person has not taken. */
function copyName(name: string, viewer: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${name}-copy` : `${name}-copy-${n}`;
    if (!taken.has(`@${viewer}/${candidate}`)) return candidate;
  }
}

/** The non-empty lines of a text area, trimmed. */
export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The form after the team owners changed: scopes no remaining owner holds are dropped. */
export function withOwners(form: IdentityForm, owners: readonly string[], scopes: readonly IdentityScope[]): IdentityForm {
  const allowed = new Set(scopeChoices(scopes, owners).map((scope) => scope.id));
  return { ...form, owners, charterScopes: form.charterScopes.filter((scope) => allowed.has(scope)) };
}

/** The form fields checked on their own as the person leaves them. */
export type CheckedField = "handle" | "name" | "job";

/** What one field needs before the form can be sent, as one clause, or undefined. */
export function fieldProblem(form: IdentityForm, field: CheckedField): string | undefined {
  if (field === "handle") {
    if (form.kind === "edit" || validHandleName(form.handleName)) return undefined;
    return form.handleName.length === 0 ? "Please enter a handle" : "Please use lowercase letters and digits in the handle";
  }
  if (field === "name") return form.name.trim().length === 0 ? "Please enter a name" : undefined;
  return form.kind === "duplicate" || form.job.trim().length > 0 ? undefined : "Please describe the job";
}

function validHandleName(name: string): boolean {
  return new RegExp(`^${HANDLE_NAME_PATTERN}$`, "u").test(name);
}

/** Whether a new handle is well formed and no identity holds it yet. An edit keeps its handle. */
export function handleIsFree(form: IdentityForm, viewer: string, taken: ReadonlySet<string>): boolean {
  return form.kind !== "edit" && validHandleName(form.handleName) && !taken.has(`@${viewer}/${form.handleName}`);
}

/** The first thing the form needs before it can be sent, as one clause, or undefined. */
export function formProblem(form: IdentityForm, limits: IdentityLimits): string | undefined {
  for (const field of ["handle", "name", "job"] as const) {
    const problem = fieldProblem(form, field);
    if (problem !== undefined) return problem;
  }
  if (form.kind === "duplicate") return undefined;
  if (form.team && form.owners.length < 2) return "Please choose at least one other owner";
  const paths = lines(form.paths);
  if (paths.length > limits.paths) return `Please keep to ${limits.paths} paths`;
  if (paths.some((path) => path.length > limits.pathLength)) return `Please keep each path under ${limits.pathLength + 1} characters`;
  const rules = lines(form.rules);
  if (rules.length > limits.rules) return `Please keep to ${limits.rules} rules`;
  if (rules.some((rule) => rule.length > limits.ruleLength)) return `Please keep each rule under ${limits.ruleLength + 1} characters`;
  return undefined;
}

/** The request the form sends: its path and its JSON body. */
export function formRequest(form: IdentityForm, viewer: string): { readonly path: string; readonly body: Record<string, unknown> } {
  const handle = `@${viewer}/${form.handleName}`;
  if (form.kind === "duplicate") {
    return { path: `/api/identities/${encodeURIComponent(form.sourceId ?? "")}/duplicate`, body: { handle, name: form.name } };
  }
  const fields: Record<string, unknown> = {
    name: form.name,
    job: form.job,
    charterScopes: form.charterScopes,
    charterPaths: lines(form.paths),
    charterRules: lines(form.rules),
    autoAccept: form.autoAccept,
  };
  // An unchanged avatar is left out, so an edit does not send the image back.
  if (form.avatar === null) fields["avatar"] = null;
  else if (form.avatar.data !== null) fields["avatar"] = { mediaType: form.avatar.mediaType, data: form.avatar.data };
  if (form.kind === "edit") return { path: `/api/identities/${encodeURIComponent(form.sourceId ?? "")}`, body: fields };
  if (form.kind === "create" && form.avatar === null) delete fields["avatar"];
  return { path: "/api/identities", body: { handle, ...fields, ...(form.team ? { owners: form.owners } : {}) } };
}

/** Why an image cannot be an avatar, as one clause, or undefined when it can. */
export function avatarProblem(file: { readonly type: string; readonly size: number }, limits: IdentityLimits): string | undefined {
  if (!AVATAR_TYPES.includes(file.type)) return "Please choose a PNG or JPEG or GIF or WebP image";
  if (file.size > limits.avatarBytes) return `Please choose an image under ${Math.floor(limits.avatarBytes / 1024)} KB`;
  return undefined;
}

/** Bytes as base64, in chunks, so a large image does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** The scope's name, or its id when the scope map no longer holds it. */
export function scopeLabel(scopes: readonly IdentityScope[], id: string): string {
  return scopes.find((scope) => scope.id === id)?.name ?? id;
}

/** The scope's test command, or undefined when the scope map no longer holds the scope. */
export function scopeTestCommand(scopes: readonly IdentityScope[], id: string): string | undefined {
  return scopes.find((scope) => scope.id === id)?.testCommand;
}

/** An identity's owners for its header's meta line, joined with commas. */
export function ownersLine(identity: IdentityEntry): string {
  return identity.owners.join(", ");
}

/** Whether any session of the identity runs now, which its list row marks with a dot. */
export function isOnline(identity: IdentityEntry): boolean {
  return identity.sessions.some((session) => session.status === "running");
}

/** The detail's tabs, in order. */
export const IDENTITY_TABS = ["details", "sessions", "history"] as const;
export type IdentityTab = (typeof IDENTITY_TABS)[number];

/** The tab an arrow, Home or End key moves to from `current`, wrapping at the ends; undefined for another key. */
export function tabAfterKey(current: IdentityTab, key: string): IdentityTab | undefined {
  const at = IDENTITY_TABS.indexOf(current);
  const last = IDENTITY_TABS.length - 1;
  if (key === "ArrowRight") return IDENTITY_TABS[at === last ? 0 : at + 1];
  if (key === "ArrowLeft") return IDENTITY_TABS[at === 0 ? last : at - 1];
  if (key === "Home") return IDENTITY_TABS[0];
  if (key === "End") return IDENTITY_TABS[last];
  return undefined;
}
