import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendDue, reconcileAssignments, reconcileCampaignTransitions } = vi.hoisted(() => ({
  sendDue: vi.fn(),
  reconcileAssignments: vi.fn(),
  reconcileCampaignTransitions: vi.fn(),
}));

// ⚠️ **كل** ما يستورده العامل يجب أن يظهر هنا (مراجعة Codex ٢١/٨): المحاكاة الجزئية تجعل
// الدالّة الغائبة `undefined`، فيرمي استدعاؤها داخل `try` ويُبتلع بوصفه «فشل مصالحة» —
// فيبقى الاختبار **أخضر وهو يختبر فرع الفشل وحده**، ولا يتحقّق قطّ من أنّ المصالحة تعمل.
vi.mock("../productStudioService", () => ({
  sendStudioDueNotifications: sendDue,
  reconcileStudioAssignmentNotifications: reconcileAssignments,
  reconcileStudioCampaignTransitionNotifications: reconcileCampaignTransitions,
}));

import {
  PRODUCT_STUDIO_NOTIFICATION_CRON,
  sweepProductStudioNotificationsOnce,
} from "../productStudioNotificationWorker";

describe("productStudioNotificationWorker", () => {
  beforeEach(() => {
    sendDue.mockReset();
    reconcileAssignments.mockReset();
    reconcileCampaignTransitions.mockReset();
    reconcileAssignments.mockResolvedValue({ createdCount: 0, missing: 0 });
    reconcileCampaignTransitions.mockResolvedValue({ createdCount: 0, claimedCount: 0 });
  });

  it("runs every five minutes and relies on stable event-key deduplication", async () => {
    const now = new Date("2026-08-19T12:00:00.000Z");
    sendDue.mockResolvedValueOnce({ createdCount: 2 });
    sendDue.mockResolvedValueOnce({ createdCount: 0 });

    expect(PRODUCT_STUDIO_NOTIFICATION_CRON).toBe("*/5 * * * *");
    await expect(sweepProductStudioNotificationsOnce(now)).resolves.toEqual({ createdCount: 2 });
    await expect(sweepProductStudioNotificationsOnce(now)).resolves.toEqual({ createdCount: 0 });
    expect(sendDue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: "admin", isOwner: true }),
      now,
      24,
    );
  });

  it("⭐ يُشغّل المصالحة فعلاً ويجمع حصيلتها مع التذكيرات", async () => {
    const now = new Date("2026-08-21T09:00:00.000Z");
    reconcileCampaignTransitions.mockResolvedValueOnce({ createdCount: 4, claimedCount: 4 });
    reconcileAssignments.mockResolvedValueOnce({ createdCount: 3, missing: 3 });
    sendDue.mockResolvedValueOnce({ createdCount: 2 });
    await expect(sweepProductStudioNotificationsOnce(now)).resolves.toEqual({ createdCount: 9 });
    expect(reconcileCampaignTransitions).toHaveBeenCalledTimes(1);
    expect(reconcileAssignments).toHaveBeenCalledTimes(1);
    expect(reconcileCampaignTransitions).toHaveBeenCalledWith(expect.objectContaining({ role: "admin", isOwner: true }));
    expect(reconcileAssignments).toHaveBeenCalledWith(expect.objectContaining({ role: "admin", isOwner: true }));
  });

  it("⭐ المصالحة تسبق تذكيرات المواعيد", async () => {
    // الترتيب ليس تفصيلاً: الموظّف يحتاج أن يعرف **أنّ** لديه مهمّة قبل أن يُذكَّر بموعدها،
    // والعكس يُنتج تذكيراً بمهمّةٍ لم يسمع بها.
    const order: string[] = [];
    reconcileCampaignTransitions.mockImplementationOnce(async () => { order.push("campaign-transition-reconcile"); return { createdCount: 0, claimedCount: 0 }; });
    reconcileAssignments.mockImplementationOnce(async () => { order.push("assignment-reconcile"); return { createdCount: 0, missing: 0 }; });
    sendDue.mockImplementationOnce(async () => { order.push("due"); return { createdCount: 0 }; });
    await sweepProductStudioNotificationsOnce(new Date("2026-08-21T09:00:00.000Z"));
    expect(order).toEqual(["campaign-transition-reconcile", "assignment-reconcile", "due"]);
  });

  it("فشلُ المصالحة لا يُسقط تذكيرات المواعيد", async () => {
    reconcileAssignments.mockRejectedValueOnce(new Error("db down"));
    sendDue.mockResolvedValueOnce({ createdCount: 4 });
    await expect(sweepProductStudioNotificationsOnce(new Date("2026-08-21T09:00:00.000Z"))).resolves.toEqual({ createdCount: 4 });
  });

  it("فشل مصالحة انتقالات الحملات لا يُسقط مصالحة الإسناد أو تذكير الموعد", async () => {
    reconcileCampaignTransitions.mockRejectedValueOnce(new Error("temporary notification outage"));
    reconcileAssignments.mockResolvedValueOnce({ createdCount: 2, missing: 2 });
    sendDue.mockResolvedValueOnce({ createdCount: 3 });

    await expect(sweepProductStudioNotificationsOnce(new Date("2026-08-21T09:00:00.000Z"))).resolves.toEqual({ createdCount: 5 });
  });
});
