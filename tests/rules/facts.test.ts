// PRD 0.5 sections 4.2 step 2 and 4.5: the facts run and the block check charge a change only with
// the breaks it makes on a running feature. A test the feature's fork already fails without the change
// is neither a break in the facts nor a failing block check.

import assert from "node:assert/strict";
import test from "node:test";

import { discountForkFailures, withoutForkFailures, type TestedResult } from "../../services/local-bridge/src/combined-run.ts";

const YEN = "checkout/tests/test_japan.py::test_yen_charged_at_face_value";
const DAY = "checkout/tests/test_cutoff.py::test_order_cutoff_is_the_stores_local_day";

test("a test the fork fails on its own head is discounted; a test the change breaks is still a break", () => {
  const breaks = withoutForkFailures([{ nodeId: YEN }, { nodeId: DAY }], new Set([YEN]));
  assert.deepEqual(
    breaks.map((each) => each.nodeId),
    [DAY],
  );
});

test("a block's tests check passes on a fork that fails only what it fails alone, and fails on what the change breaks", () => {
  const failed = (...nodeIds: string[]) =>
    ({ status: "failed", target: "japan-launch", failingTests: nodeIds.map((nodeId) => ({ nodeId, testId: nodeId })) }) as unknown as TestedResult;
  const own = discountForkFailures(failed(YEN), new Set([YEN]));
  assert.equal(own.status, "passed");
  assert.equal(own.failingAlone, 1);
  const broken = discountForkFailures(failed(YEN, DAY), new Set([YEN]));
  assert.equal(broken.status, "failed");
  assert.deepEqual(
    broken.failingTests.map((each) => each.nodeId),
    [DAY],
  );
});
