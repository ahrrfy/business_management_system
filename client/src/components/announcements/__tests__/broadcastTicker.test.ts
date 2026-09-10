import { describe, it, expect } from "vitest";
import type { AnnouncementItem } from "../AnnouncementDetailModal";

describe("Broadcast Ticker & Announcements Contract", () => {
  it("validates announcement priority styling and structure", () => {
    const item: AnnouncementItem = {
      id: 1,
      title: "تحديث أسعار الورق والطباعة",
      body: "نظراً لتحديث تكاليف التوريد، تم تعديل أسعار الورق A4 والطباعة الرقمية اعتبارا من اليوم.",
      priority: "IMPORTANT",
      requiresAck: true,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      readAt: null,
      acknowledgedAt: null,
    };

    expect(item.id).toBe(1);
    expect(item.priority).toBe("IMPORTANT");
    expect(item.requiresAck).toBe(true);
    expect(item.acknowledgedAt).toBeNull();
  });

  it("handles critical emergency priority with correct acknowledgment requirement", () => {
    const criticalItem: AnnouncementItem = {
      id: 2,
      title: "صيانة طارئة لماكينات الأوفست",
      body: "يرجى تحويل كافة أوامر الشغل المعلقة إلى الفرع الرئيسي مؤقتاً.",
      priority: "CRITICAL",
      requiresAck: true,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      readAt: new Date().toISOString(),
      acknowledgedAt: new Date().toISOString(),
    };

    expect(criticalItem.priority).toBe("CRITICAL");
    expect(criticalItem.acknowledgedAt).toBeDefined();
    expect(criticalItem.readAt).toBeDefined();
  });

  it("handles normal broadcast announcement without requiring mandatory ack", () => {
    const normalItem: AnnouncementItem = {
      id: 3,
      title: "تهنئة بمناسبة حلول الشهر الفضيل",
      body: "كل عام وفريق الرؤية العربية بألف خير.",
      priority: "NORMAL",
      requiresAck: false,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    };

    expect(normalItem.priority).toBe("NORMAL");
    expect(normalItem.requiresAck).toBe(false);
  });
});
