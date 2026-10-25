import { expect, it } from "vitest";
import { deviceConnectionFeedback } from "./hrDeviceOperations";

it("does not infer physical connectivity from a failed refresh or cached online row", () => {
  expect(deviceConnectionFeedback({ isError: true, data: [{ id: 1, enabled: true, status: "online" }] }, 1).kind).toBe("err");
});
it("requires a fresh enabled online device for a successful check", () => {
  expect(deviceConnectionFeedback({ isError: false, data: [{ id: 1, enabled: true, status: "online" }] }, 1).kind).toBe("ok");
});
it("distinguishes an unapproved online device", () => {
  expect(deviceConnectionFeedback({ isError: false, data: [{ id: 1, enabled: false, status: "online" }] }, 1).message).toContain("الاعتماد");
});
it("distinguishes an absent device and a disconnected one", () => {
  expect(deviceConnectionFeedback({ isError: false, data: [] }, 1).message).toContain("غير موجود");
  expect(deviceConnectionFeedback({ isError: false, data: [{ id: 1, enabled: true, status: "offline" }] }, 1).message).toContain("إشارة حديثة");
});
