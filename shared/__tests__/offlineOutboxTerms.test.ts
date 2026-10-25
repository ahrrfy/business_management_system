import { expect, it } from "vitest";
import { offlineOutboxStatusLabel } from "../offlineOutboxTerms";
it.each([
  ["QUEUED", "بانتظار المزامنة"],
  ["SENDING", "قيد الترحيل"],
  ["SENT", "تم الترحيل"],
  ["PARKED", "معلق للمراجعة"],
  ["constructor", "constructor"],
])("formats outbox status %s", (status, label) => {
  expect(offlineOutboxStatusLabel(status)).toBe(label);
});
