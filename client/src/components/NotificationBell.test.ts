import { describe, expect, it } from "vitest";
import {
  familyLabel,
  newestInlineNotification,
  notificationBadgeLabel,
  safeNotificationRoute,
} from "./NotificationBell";

describe("جرس الإشعارات العام", () => {
  it("يعرض العائلات الخمس بتسميات عربية واضحة", () => {
    expect(familyLabel("OPERATIONS")).toBe("تشغيلية");
    expect(familyLabel("ADMIN")).toBe("إدارية");
    expect(familyLabel("EMPLOYEE")).toBe("الموظف");
    expect(familyLabel("SYSTEM")).toBe("النظام");
    expect(familyLabel("APPROVAL")).toBe("اعتماد");
  });

  it("يحد شارة غير المقروء عند 99+", () => {
    expect(notificationBadgeLabel(0)).toBe("0");
    expect(notificationBadgeLabel(12)).toBe("12");
    expect(notificationBadgeLabel(100)).toBe("99+");
  });

  it("لا يسمح لوجهة الإشعار بالخروج من التطبيق", () => {
    expect(safeNotificationRoute("/attendance")).toBe("/attendance");
    expect(safeNotificationRoute("https://evil.example")).toBe("/my-work");
    expect(safeNotificationRoute("//evil.example")).toBe("/my-work");
    expect(safeNotificationRoute(undefined)).toBe("/my-work");
  });

  it("يعرض أحدث إشعار جديد مرة واحدة ويتقدم حتى لو كانت بعض الصفوف مقروءة", () => {
    const rows = [
      { id: 14, readAt: null, title: "مهمة", body: "أُسندت إليك" },
      { id: 13, readAt: new Date(), title: "قديم", body: "مقروء" },
    ];
    expect(newestInlineNotification(rows, 13)).toEqual({ nextSeenId: 14, row: rows[0] });
    expect(newestInlineNotification(rows, 14)).toEqual({ nextSeenId: 14, row: null });
  });
});
