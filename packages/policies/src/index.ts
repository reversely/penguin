export const packageName: string = "@penguin/policies";

export {
  operationTargets,
  withinCharter,
  type CharterIdentity,
  type CharterVerdict,
  type OperationTargets,
} from "./charter.ts";
export {
  labelledScopes,
  reviewOwners,
  reviewRight,
  SCOPE_LABEL_PREFIX,
  type Delegates,
  type ReviewRight,
} from "./review-rights.ts";
export {
  fixApproval,
  fixHead,
  type FixApproval,
  type FixRecord,
  type LinkedCommitRecord,
  type OwnerApproval,
  type OwnerApprovalState,
  type ReviewRecord,
} from "./fix-approval.ts";
export {
  segmentPerson,
  threadPeople,
  threadResolveRight,
  type ThreadRecord,
  type ThreadRight,
} from "./thread-rights.ts";
export {
  approvedCommit,
  closeBlockers,
  closeRefusal,
  openThreadsOf,
  verifiedIntegration,
  type CloseCheckRecord,
  type CloseInput,
  type CloseRefusal,
  type CloseThreadRecord,
  type FixCloseRecord,
  type HuddleCloseRecord,
  type OpenThread,
} from "./huddle-close.ts";
