import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendDue } = vi.hoisted(() => ({ sendDue: vi.fn() }));

vi.mock("../productStudioService", () => ({
  sendStudioDueNotifications: sendDue,
}));

import {
  PRODUCT_STUDIO_NOTIFICATION_CRON,
  sweepProductStudioNotificationsOnce,
} from "../productStudioNotificationWorker";

describe("productStudioNotificationWorker", () => {
  beforeEach(() => {
    sendDue.mockReset();
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
});
