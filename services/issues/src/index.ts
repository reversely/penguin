export const packageName: string = "@penguin/issues";

export {
  approvedCommit,
  closeBlockers,
  fixApproval,
  fixHead,
  openThreadsOf,
  reviewOwners,
  SCOPE_LABEL_PREFIX,
  threadPeople,
  verifiedIntegration,
  withinCharter,
  type CharterIdentity,
  type Delegates,
  type FixApproval,
  type OpenThread,
  type OwnerApproval,
  type OwnerApprovalState,
} from "@penguin/policies";

export { canonicalBytes, canonicalJson } from "./canonical.ts";
export {
  fromBase64Url,
  generateSigningKeyPair,
  importPrivateKey,
  importPublicKey,
  signOperation,
  signingBytes,
  toBase64Url,
  verifyOperation,
} from "./signature.ts";
export {
  REJECT_REASONS,
  validate,
  type BridgeKey,
  type FixLookup,
  type IdentityLookup,
  type IssueState,
  type RejectReason,
  type Signer,
  type ValidationContext,
  type Verdict,
} from "./validate.ts";
export {
  issueKey,
  reduce,
  REDUCE_REJECT_REASONS,
  type Assignment,
  type Check,
  type Comment,
  type CommentRevision,
  type HuddleContext,
  type IssueRecord,
  type IssueStateName,
  type LinkedCommit,
  type Mention,
  type ReduceContext,
  type ReduceRejectReason,
  type ReduceResult,
  type Review,
  type SubIssue,
  type Thread,
} from "./reduce.ts";
