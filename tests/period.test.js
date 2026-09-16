import test from "node:test";
import assert from "node:assert/strict";

import { monthRangeFromKey } from "../lib/period.js";

test("monthRangeFromKey returns the full calendar month", () => {
  assert.deepEqual(monthRangeFromKey("2026-03"), {
    from: "2026-03-01",
    to: "2026-03-31",
  });
});

test("monthRangeFromKey handles February in leap years", () => {
  assert.deepEqual(monthRangeFromKey("2024-02"), {
    from: "2024-02-01",
    to: "2024-02-29",
  });
});
