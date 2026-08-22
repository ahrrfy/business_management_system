import { describe, expect, it } from "vitest";
import {
  canEditStudioTask,
  canReviewStudioTask,
  needsStudioEditOverride,
  needsStudioReviewOverride,
} from "../studioWorkflowPolicy";

const activeTask = { status: "IN_PROGRESS", assignedTo: 20, submittedBy: null } as const;
const reviewTask = { status: "PENDING_REVIEW", assignedTo: 20, submittedBy: 21 } as const;

describe("Product Studio UI separation-of-duties policy", () => {
  it("allows only the assignee to edit unless an admin supplies an explicit reason", () => {
    expect(canEditStudioTask(activeTask, { userId: 20, role: "print_operator" })).toBe(true);
    expect(canEditStudioTask(activeTask, { userId: 30, role: "manager" }, "سبب لا يمنح المدير تجاوزاً")).toBe(false);
    expect(canEditStudioTask(activeTask, { userId: 40, role: "admin" })).toBe(false);
    expect(needsStudioEditOverride(activeTask, { userId: 40, role: "admin" })).toBe(true);
    expect(canEditStudioTask(activeTask, { userId: 40, role: "admin" }, "تعذر العامل عن إكمال المهمة")).toBe(true);
  });

  it("requires an independent reviewer from both assignee and last submitter", () => {
    expect(canReviewStudioTask(reviewTask, { userId: 30, role: "manager" })).toBe(true);
    expect(canReviewStudioTask(reviewTask, { userId: 20, role: "manager" })).toBe(false);
    expect(canReviewStudioTask(reviewTask, { userId: 21, role: "manager" })).toBe(false);
    expect(canReviewStudioTask(reviewTask, { userId: 21, role: "admin" })).toBe(false);
    expect(needsStudioReviewOverride(reviewTask, { userId: 21, role: "admin" })).toBe(true);
    expect(canReviewStudioTask(reviewTask, { userId: 21, role: "admin" }, "تصحيح إداري موثق لغياب مراجع مستقل")).toBe(true);
  });
});
