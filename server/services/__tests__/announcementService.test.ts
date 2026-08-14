import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { appNotifications, branches, nativePushOutbox, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  acknowledgeAnnouncement,
  createAnnouncement,
  getAnnouncementWithReaders,
  listAnnouncements,
  markAnnouncementRead,
  myAnnouncements,
  setAnnouncementActive,
} from "../announcementService";
import type { NormalizedNativePushPayload } from "../nativePushService";

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  await d.execute(sql`TRUNCATE TABLE announcementReads`);
  await d.execute(sql`TRUNCATE TABLE announcements`);
  await d.execute(sql`TRUNCATE TABLE appNotifications`);
  await d.execute(sql`TRUNCATE TABLE nativePushOutbox`);
  await d.execute(sql`TRUNCATE TABLE users`);
  await d.execute(sql`TRUNCATE TABLE branches`);
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(users).values([
    { id: 10, openId: "admin", name: "أدمن", role: "admin", branchId: 1 },
    { id: 11, openId: "cash1", name: "كاشير١", role: "cashier", branchId: 1 },
    { id: 12, openId: "cash2", name: "كاشير٢", role: "cashier", branchId: 2 },
    { id: 13, openId: "wh1", name: "مخزن١", role: "warehouse", branchId: 1 },
    { id: 14, openId: "off", name: "معطّل", role: "cashier", branchId: 1, isActive: false },
  ]);
});

const cash2 = { id: 12, role: "cashier", branchId: 2 };

describe("announcementService", () => {
  it("recipientCount لجمهور ALL = النشطون فقط (يستبعد المعطّل)", async () => {
    const r = await createAnnouncement({ title: "اجتماع", body: "غداً ٩ص", audienceType: "ALL" }, 10);
    expect(r.recipientCount).toBe(4); // 10,11,12,13 — المعطّل 14 مستبعَد
  });

  it("recipientCount لجمهور BRANCH/ROLE مقصورٌ على المستهدَف", async () => {
    const branch = await createAnnouncement(
      { title: "فرع", body: "..", audienceType: "BRANCH", audienceBranchId: 2 },
      10,
    );
    expect(branch.recipientCount).toBe(1); // cash2 فقط
    const role = await createAnnouncement({ title: "كاشيرون", body: "..", audienceType: "ROLE", audienceRole: "cashier" }, 10);
    expect(role.recipientCount).toBe(2); // cash1 + cash2 النشطان
  });

  it("النشر يُعمّم إشعاراً لكل مستهدَفٍ نشط عدا الناشر (داخل التطبيق + دفع أصيل)", async () => {
    const d = db();
    const a = await createAnnouncement({ title: "اجتماع", body: "غداً ٩ص", audienceType: "ALL" }, 10);
    const notes = await d.select().from(appNotifications).where(eq(appNotifications.kind, "ANNOUNCEMENT"));
    // المستهدَف النشط 10,11,12,13؛ الناشر 10 مُستثنى والمعطّل 14 مستبعَد ⇒ 11,12,13.
    expect(notes.map((n) => Number(n.userId)).sort((x, y) => x - y)).toEqual([11, 12, 13]);
    expect(notes.every((n) => Number(n.entityId) === a.id)).toBe(true);
    // دفعٌ أصيل مُدرَجٌ في الصندوق الصادر لمستهدَفٍ نشط.
    const push = await d.select().from(nativePushOutbox).where(eq(nativePushOutbox.userId, 11));
    expect(push.length).toBeGreaterThanOrEqual(1);
  });

  it("دفع الإعلان مُنقَّحٌ على شاشة القفل افتراضاً — لا يُسرّب العنوان/النص", async () => {
    const d = db();
    await createAnnouncement({ title: "اجتماع سرّي", body: "تفاصيل داخليّة", audienceType: "ALL" }, 10);
    const [push] = await d.select().from(nativePushOutbox).where(eq(nativePushOutbox.userId, 11));
    // حمولات FCM نصّية ⇒ العَلَم يُسلسَل نصّاً "true" لا boolean.
    const payload = push.payload as NormalizedNativePushPayload;
    expect(payload.sensitive).toBe("true");
    expect(payload.title).toBe("تحديث آمن");
    expect(payload.body).toBe("افتح سوبر العربية لعرض التفاصيل.");
    // النصّ الأصليّ لا يُسرَّب في حمولة الدفع (شاشة القفل تعرض النصّ الآمن فقط).
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("اجتماع سرّي");
    expect(serialized).not.toContain("تفاصيل داخليّة");
  });

  it("تعميم BRANCH يقصر الإشعار على الفرع المستهدَف وحده", async () => {
    const d = db();
    await createAnnouncement({ title: "فرع٢", body: "..", audienceType: "BRANCH", audienceBranchId: 2 }, 10);
    const notes = await d.select().from(appNotifications).where(eq(appNotifications.kind, "ANNOUNCEMENT"));
    expect(notes.map((n) => Number(n.userId))).toEqual([12]); // cash2 (فرع ٢) فقط
  });

  it("يرفض إنشاء إعلانٍ بتاريخ انتهاءٍ ماضٍ", async () => {
    await expect(
      createAnnouncement({ title: "x", body: "..", audienceType: "ALL", expiresAt: new Date(Date.now() - 60_000) }, 10),
    ).rejects.toThrow();
  });

  it("mine يعيد إعلانات الموظف المستهدَفة فقط + عدّاد غير المقروء", async () => {
    await createAnnouncement({ title: "للكل", body: "..", audienceType: "ALL" }, 10);
    const branchAnn = await createAnnouncement(
      { title: "فرع٢", body: "..", audienceType: "BRANCH", audienceBranchId: 2 },
      10,
    );
    await createAnnouncement({ title: "فرع١", body: "..", audienceType: "BRANCH", audienceBranchId: 1 }, 10);

    let mine = await myAnnouncements(cash2);
    const titles = mine.rows.map((row) => row.title);
    expect(titles).toHaveLength(2);
    expect(titles).toContain("للكل");
    expect(titles).toContain("فرع٢");
    expect(titles).not.toContain("فرع١");
    expect(mine.unreadCount).toBe(2);

    await markAnnouncementRead(cash2, branchAnn.id);
    mine = await myAnnouncements(cash2);
    expect(mine.unreadCount).toBe(1);
  });

  it("unreadCount غير مقيَّد بحجم الصفحة", async () => {
    for (let i = 0; i < 3; i++) {
      await createAnnouncement({ title: `n${i}`, body: "..", audienceType: "ALL" }, 10);
    }
    const mine = await myAnnouncements(cash2, 1); // صفحة واحدة
    expect(mine.rows).toHaveLength(1);
    expect(mine.unreadCount).toBe(3); // العدّاد يتجاوز الصفحة
  });

  it("الإقرار يتطلّب requiresAck ويُسجَّل في تفاصيل الإدارة", async () => {
    const a = await createAnnouncement({ title: "إلزاميّ", body: "..", audienceType: "ALL", requiresAck: true }, 10);
    await acknowledgeAnnouncement(cash2, a.id);
    const detail = await getAnnouncementWithReaders(a.id);
    expect(detail?.readers).toHaveLength(1);
    expect(detail?.readers[0]).toMatchObject({ userId: 12 });
    expect(detail?.readers[0].acknowledgedAt).not.toBeNull();
  });

  it("الإقرار على إعلانٍ لا يتطلّبه يُرفَض", async () => {
    const a = await createAnnouncement({ title: "اختياريّ", body: "..", audienceType: "ALL", requiresAck: false }, 10);
    await expect(acknowledgeAnnouncement(cash2, a.id)).rejects.toThrow();
  });

  it("القراءة لإعلانٍ لا يخصّ الموظف تُرفَض (حارس IDOR)", async () => {
    const branch1 = await createAnnouncement(
      { title: "فرع١", body: "..", audienceType: "BRANCH", audienceBranchId: 1 },
      10,
    );
    await expect(markAnnouncementRead(cash2, branch1.id)).rejects.toThrow();
  });

  it("list يُظهر عدّادَي القراءة والإقرار", async () => {
    const a = await createAnnouncement({ title: "x", body: "..", audienceType: "ALL", requiresAck: true }, 10);
    await markAnnouncementRead({ id: 11, role: "cashier", branchId: 1 }, a.id);
    await acknowledgeAnnouncement(cash2, a.id);
    const list = await listAnnouncements();
    expect(list[0]).toMatchObject({ id: a.id, readCount: 2, ackCount: 1 });
  });

  it("setAnnouncementActive يعيد false لمعرّفٍ غير موجود", async () => {
    expect(await setAnnouncementActive(999999, false)).toBe(false);
    const a = await createAnnouncement({ title: "x", body: "..", audienceType: "ALL" }, 10);
    expect(await setAnnouncementActive(a.id, false)).toBe(true);
  });
});
