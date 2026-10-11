import assert from "node:assert/strict";
import { test } from "node:test";

import { failureLines, testDocstring, testFunctionName } from "@penguin/local-bridge";

const SOURCE = [
  "import pytest",
  "",
  "",
  "def test_plain():",
  '    """Patrons who log in on one library tablet',
  '    stay separate people."""',
  "    assert 1 == 3",
  "",
  "",
  "def test_without_docstring():",
  "    # A comment is not a docstring.",
  "    assert True",
  "",
  "",
  "@pytest.mark.parametrize('n', [1, 2])",
  "def test_wrapped(",
  "    n,",
  ") -> None:",
  "    r'''Raw single-quoted docstring.'''",
  "",
  "",
  "class TestGroup:",
  "    def test_method(self):",
  '        "One line in double quotes."',
].join("\n");

test("testDocstring reads a test's docstring onto one line, and nothing for a test without one", () => {
  assert.equal(testDocstring(SOURCE, "test_plain"), "Patrons who log in on one library tablet stay separate people.");
  assert.equal(testDocstring(SOURCE, "test_without_docstring"), undefined);
  assert.equal(testDocstring(SOURCE, "test_wrapped"), "Raw single-quoted docstring.");
  assert.equal(testDocstring(SOURCE, "test_method"), "One line in double quotes.");
  assert.equal(testDocstring(SOURCE, "test_missing"), undefined);
});

test("testFunctionName drops the class and the parametrize suffix", () => {
  assert.equal(testFunctionName("a/test_x.py::test_wrapped[1]"), "test_wrapped");
  assert.equal(testFunctionName("a/test_x.py::TestGroup::test_method"), "test_method");
});

const LOG = [
  "============================= test session starts ==============================",
  "collected 3 items",
  "",
  "analytics/tests/test_identity.py F                                        [ 50%]",
  "",
  "=================================== FAILURES ===================================",
  "\x1b[31m___________________________ test_shared_device_split ___________________________\x1b[0m",
  "",
  "    def test_shared_device_split():",
  '        """Patrons who log in on one library tablet stay separate people."""',
  ">       assert _dau(events) == {\"2026-01-05\": 3}",
  "E       AssertionError: assert {'2026-01-05': 1} == {'2026-01-05': 3}",
  "E         Differing items:",
  "",
  "analytics/tests/test_identity.py:28: AssertionError",
  "_____________________________ TestGroup.test_method _____________________________",
  "",
  ">       helper()",
  "",
  "analytics/tests/test_group.py:4: ",
  "_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _",
  ">       raise ValueError('no day')",
  "E       ValueError: no day",
  "",
  "analytics/helpers.py:2: ValueError",
  "=========================== short test summary info ============================",
  "FAILED analytics/tests/test_identity.py::test_shared_device_split - AssertionError",
].join("\n");

test("failureLines finds each failing test's assertion line and first error line in a pytest log", () => {
  const lines = failureLines(LOG, [
    "analytics/tests/test_identity.py::test_shared_device_split",
    "analytics/tests/test_group.py::TestGroup::test_method",
    "analytics/tests/test_other.py::test_absent",
  ]);
  assert.deepEqual(Object.fromEntries(lines), {
    "analytics/tests/test_identity.py::test_shared_device_split": {
      assertion: 'assert _dau(events) == {"2026-01-05": 3}',
      error: "AssertionError: assert {'2026-01-05': 1} == {'2026-01-05': 3}",
    },
    // The test's own line, where it called the code that failed, and the error from deeper down.
    "analytics/tests/test_group.py::TestGroup::test_method": { assertion: "helper()", error: "ValueError: no day" },
  });
});

test("failureLines finds nothing in a log without a FAILURES section", () => {
  assert.equal(failureLines("FAILED a/test_x.py::test_y\n", ["a/test_x.py::test_y"]).size, 0);
});
