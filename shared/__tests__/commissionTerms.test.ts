import { expect, it } from "vitest";
import { commissionStatusLabel } from "../commissionTerms";
it.each([
  ["draft", "قيد المراجعة"],
  ["approved", "معتمدة"],
  ["future", "future"],
  ["constructor", "constructor"],
])("formats commission status %s", (status, label) => {
  expect(commissionStatusLabel(status)).toBe(label);
});
