// PRD 0.5 section 4.2 step 2: the facts run states each break the change makes on a running feature.
// A test the feature's fork already fails without the change is not one of them.

import assert from "node:assert/strict";
import test from "node:test";

import { withoutForkFailures } from "../../services/local-bridge/src/plan-facts-run.ts";

test("a test the fork fails on its own head is discounted; a test the change breaks is still a break", () => {
  const yen = "checkout/tests/test_japan.py::test_yen_charged_at_face_value";
  const day = "checkout/tests/test_cutoff.py::test_order_cutoff_is_the_stores_local_day";
  const breaks = withoutForkFailures([{ nodeId: yen }, { nodeId: day }], new Set([yen]));
  assert.deepEqual(
    breaks.map((test) => test.nodeId),
    [day],
  );
});
