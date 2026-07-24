/**
 * تقطير البث التسويقي عبر الكنّاس (S5، T5.2) — broadcastDispatch.dripRunningBroadcasts +
 * webhookProcessor (ربط الحالات) + broadcastService.resumeBroadcast/broadcastResults:
 *  1) 🔴 القاعدة الذهبية: OPTED_IN فقط في الإدراج/الإرسال الفعلي — UNKNOWN وOPTED_OUT مستبعَدان
 *     دائماً بصرف النظر عن segmentJson (requireOptIn محلّي غير مضبوط في اللقطة).
 *  2) التقطير المقنَّن: throttlePerMinute يحدّ عدد الصفوف المُنقَّطة إلى outbox في كل دورة.
 *  3) opt-out منتصف الحملة: مستلم PENDING صار OPTED_OUT بعد الإطلاق ⇒ SKIPPED_OPTOUT لا يُرسَل.
 *  4) القاطع (circuit breaker): فشل >٢٠٪ من آخر ٥٠ مُرسَلاً، أو ظهور كود Meta (131048/131056/130429)
 *     ⇒ PAUSED تلقائياً بسببٍ عربي واضح؛ resumeBroadcast يعيدها RUNNING.
 *  5) ربط الحالات: تحديث waOutbox من webhook (SENT/DELIVERED/READ/FAILED+errorCode) لصفّ حملة ⇒
 *     recipientStatus يتبعه (عبر processStatuses في webhookProcessor.ts).
 *  6) الإكمال: لا PENDING متبقٍّ (يشمل شريحة فارغة تماماً) ⇒ COMPLETED.
 *  7) idempotency: نداءان متتاليان لا يُدرجان مستلمين مكرَّرين (uq) ولا يُرسلان مكرَّراً (dedupeKey).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { broadcastResults, resumeBroadcast } from "../whatsapp/broadcastService";
import { dripRunningBroadcasts } from "../whatsapp/broadcastDispatch";
import { persistWaEvent, processWaEvent } from "../whatsapp/webhookProcessor";
import type { Actor } from "../tx";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

const admin: Actor = { userId: 1, branchId: 1, role: "admin" };

beforeEach(async () => {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values([{ id: 1, openId: "admin", name: "المدير العام", role: "admin", loginMethod: "local", branchId: 1 }]);
  await db().insert(s.waHubSettings).values({ id: 1, campaignApprovalThreshold: 500, killSwitch: false });
  await db().insert(s.waTemplates).values({
    id: 1,
    name: "promo_sale",
    language: "ar",
    category: "MARKETING",
    templateStatus: "APPROVED",
    bodyText: "عرض خاص لك {{1}}",
    variableCount: 1,
  });
});

async function seedCustomer(id: number, consent: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT"): Promise<void> {
  await db()
    .insert(s.customers)
    .values({ id, name: `عميل ${id}`, phone: `0770${String(id).padStart(7, "0")}`, customerType: "فرد", waConsent: consent, isActive: true });
}

async function insertRunningBroadcast(
  overrides: {
    segmentJson?: Record<string, unknown>;
    throttlePerMinute?: number;
    branchId?: number | null;
  } = {},
): Promise<number> {
  const res = await db()
    .insert(s.waBroadcasts)
    .values({
      name: "حملة اختبار",
      branchId: overrides.branchId === undefined ? 1 : overrides.branchId,
      templateId: 1,
      templateLang: "ar",
      segmentJson: overrides.segmentJson ?? { customerTypes: ["فرد"] },
      broadcastStatus: "RUNNING",
      audienceCount: 0,
      costEstimate: "0.00",
      throttlePerMinute: overrides.throttlePerMinute ?? 10,
      startedAt: new Date(),
      createdBy: 1,
    });
  return extractInsertId(res);
}

async function recipientsOf(broadcastId: number) {
  return db().select().from(s.waBroadcastRecipients).where(eq(s.waBroadcastRecipients.broadcastId, broadcastId)).orderBy(s.waBroadcastRecipients.id);
}
async function outboxOf(broadcastId: number) {
  return db().select().from(s.waOutbox).where(eq(s.waOutbox.campaignId, broadcastId));
}
async function broadcastRow(broadcastId: number) {
  return (await db().select().from(s.waBroadcasts).where(eq(s.waBroadcasts.id, broadcastId)))[0];
}

describe("🔴 القاعدة الذهبية — OPTED_IN فقط في الإدراج الفعلي", () => {
  it("UNKNOWN وOPTED_OUT مستبعَدان دائماً؛ OPTED_IN فقط يُدرَج ويُقطَّر رغم segmentJson بلا requireOptIn", async () => {
    await seedCustomer(1, "UNKNOWN");
    await seedCustomer(2, "OPTED_IN");
    await seedCustomer(3, "OPTED_OUT");
    // segmentJson لا يفرض requireOptIn — القاعدة يجب أن تُفرَض في الكود بصرف النظر.
    const broadcastId = await insertRunningBroadcast({ segmentJson: { customerTypes: ["فرد"] } });

    await dripRunningBroadcasts();

    const recipients = await recipientsOf(broadcastId);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].customerId).toBe(2);
    expect(recipients[0].recipientStatus).toBe("QUEUED");
    expect(recipients[0].outboxId).not.toBeNull();

    const outbox = await outboxOf(broadcastId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].kind).toBe("TEMPLATE");
    expect(outbox[0].toPhoneE164).toBe(recipients[0].phoneE164);
  });
});

describe("التقطير المقنَّن — throttlePerMinute يحدّ الإدراج في outbox لكل دورة", () => {
  it("throttlePerMinute=2 وحملة بـ٥ مؤهّلين ⇒ ٢ ثم ٢ ثم ١، ثم COMPLETED", async () => {
    for (let i = 1; i <= 5; i++) await seedCustomer(i, "OPTED_IN");
    const broadcastId = await insertRunningBroadcast({ throttlePerMinute: 2 });

    await dripRunningBroadcasts();
    expect(await outboxOf(broadcastId)).toHaveLength(2);
    expect((await broadcastRow(broadcastId)).broadcastStatus).toBe("RUNNING");

    await dripRunningBroadcasts();
    expect(await outboxOf(broadcastId)).toHaveLength(4);
    expect((await broadcastRow(broadcastId)).broadcastStatus).toBe("RUNNING");

    await dripRunningBroadcasts();
    expect(await outboxOf(broadcastId)).toHaveLength(5);
    expect((await broadcastRow(broadcastId)).broadcastStatus).toBe("COMPLETED");
    expect((await broadcastRow(broadcastId)).completedAt).not.toBeNull();

    // كل الصفوف القطاعية الخمسة انتهت QUEUED (لا PENDING متبقٍّ).
    const recipients = await recipientsOf(broadcastId);
    expect(recipients).toHaveLength(5);
    expect(recipients.every((r) => r.recipientStatus === "QUEUED")).toBe(true);
  });
});

describe("opt-out منتصف الحملة — يُحترَم حتماً", () => {
  it("مستلم PENDING صار OPTED_OUT بعد الإطلاق ⇒ SKIPPED_OPTOUT لا يُرسَل أبداً", async () => {
    await seedCustomer(1, "OPTED_IN");
    await seedCustomer(2, "OPTED_IN");
    await seedCustomer(3, "OPTED_IN");
    const broadcastId = await insertRunningBroadcast({ throttlePerMinute: 1 });

    await dripRunningBroadcasts(); // يُدرج ٣ PENDING، يُقطِّر ١ (عميل ١) ⇒ QUEUED.
    let recipients = await recipientsOf(broadcastId);
    expect(recipients).toHaveLength(3);
    expect(recipients.find((r) => r.customerId === 1)!.recipientStatus).toBe("QUEUED");
    expect(recipients.find((r) => r.customerId === 2)!.recipientStatus).toBe("PENDING");

    // العميل ٢ ينسحب منتصف الحملة (بعد إدراج صفّه PENDING، قبل تقطيره).
    await db().update(s.customers).set({ waConsent: "OPTED_OUT" }).where(eq(s.customers.id, 2));

    await dripRunningBroadcasts(); // يُقطِّر ١ إضافياً (بترتيب id ⇒ عميل ٢).
    recipients = await recipientsOf(broadcastId);
    const c2 = recipients.find((r) => r.customerId === 2)!;
    expect(c2.recipientStatus).toBe("SKIPPED_OPTOUT");
    expect(c2.outboxId).toBeNull();

    // لا صفّ outbox للعميل ٢ — فقط للعميل ١ (من الدورة الأولى).
    const outbox = await outboxOf(broadcastId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].toPhoneE164).toBe(recipients.find((r) => r.customerId === 1)!.phoneE164);
  });
});

describe("القاطع (circuit breaker) — يوقف الحملة تلقائياً + resumeBroadcast يستأنفها", () => {
  it("فشل >٢٠٪ من آخر المُرسَلين ⇒ PAUSED بسببٍ عربي؛ لا مستلمين جدد أُدرجوا؛ resumeBroadcast ⇒ RUNNING", async () => {
    const broadcastId = await insertRunningBroadcast({ segmentJson: {} });
    // نحاكي تاريخ إرسال سابقاً (٣ فشل من ١٠ = ٣٠٪ > ٢٠٪) — بلا مرور بالتقطير الفعلي.
    const rows = Array.from({ length: 10 }, (_, i) => ({
      broadcastId,
      customerId: null,
      phoneE164: `07701112${String(i).padStart(3, "0")}`,
      recipientStatus: (i < 3 ? "FAILED" : "SENT") as "FAILED" | "SENT",
    }));
    await db().insert(s.waBroadcastRecipients).values(rows);

    await dripRunningBroadcasts();

    const row = await broadcastRow(broadcastId);
    expect(row.broadcastStatus).toBe("PAUSED");
    expect(row.pausedReason).toBeTruthy();
    expect(row.pausedReason).toContain("فشل");

    // لم يُحاول الإدراج الكسول (القاطع يُفحص قبل أي تقطير) — لا يزال ١٠ صفوف فقط.
    expect(await recipientsOf(broadcastId)).toHaveLength(10);

    const resumed = await resumeBroadcast(broadcastId, admin);
    expect(resumed.status).toBe("RUNNING");
    const rowAfterResume = await broadcastRow(broadcastId);
    expect(rowAfterResume.broadcastStatus).toBe("RUNNING");
    expect(rowAfterResume.pausedReason).toBeNull();
  });

  it("errorCode 131048 على مُرسَل واحد فقط (فشل ١٠٪ < ٢٠٪) ⇒ PAUSED أيضاً بسبب كود Meta", async () => {
    const broadcastId = await insertRunningBroadcast({ segmentJson: {} });
    const rows = Array.from({ length: 10 }, (_, i) => ({
      broadcastId,
      customerId: null,
      phoneE164: `07702223${String(i).padStart(3, "0")}`,
      recipientStatus: (i === 0 ? "FAILED" : "SENT") as "FAILED" | "SENT",
      errorCode: i === 0 ? "131048" : null,
    }));
    await db().insert(s.waBroadcastRecipients).values(rows);

    await dripRunningBroadcasts();

    const row = await broadcastRow(broadcastId);
    expect(row.broadcastStatus).toBe("PAUSED");
    expect(row.pausedReason).toBeTruthy();
  });
});

describe("ربط الحالات — تحديث outbox من webhook يتبعه recipientStatus", () => {
  async function statusPayload(wamid: string, status: string, errors?: Array<{ code: number; title: string }>) {
    return {
      entry: [
        {
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "15550009999", display_phone_number: "15550009999" },
                statuses: [{ id: wamid, status, timestamp: "1690000000", errors }],
              },
            },
          ],
        },
      ],
    };
  }
  async function runStatusEvent(wamid: string, status: string, errors?: Array<{ code: number; title: string }>): Promise<void> {
    const { id } = await persistWaEvent(await statusPayload(wamid, status, errors), null);
    await processWaEvent(id);
  }

  it("delivered ⇒ recipientStatus=DELIVERED", async () => {
    await seedCustomer(1, "OPTED_IN");
    const broadcastId = await insertRunningBroadcast();
    await dripRunningBroadcasts();
    const recipient = (await recipientsOf(broadcastId))[0];
    expect(recipient.outboxId).not.toBeNull();

    // محاكاة finalizeSendSuccess (خارج نطاق هذا التكليف — outboxService.ts): wamid يُكتَب بعد إرسال فعلي.
    await db().update(s.waOutbox).set({ wamid: "wamid.CAMP1", status: "SENT" }).where(eq(s.waOutbox.id, recipient.outboxId!));

    await runStatusEvent("wamid.CAMP1", "delivered");

    const after = (await recipientsOf(broadcastId))[0];
    expect(after.recipientStatus).toBe("DELIVERED");
    expect(after.wamid).toBe("wamid.CAMP1");
  });

  it("failed بكود ⇒ recipientStatus=FAILED + errorCode مطابق (يغذّي القاطع لاحقاً)", async () => {
    await seedCustomer(1, "OPTED_IN");
    const broadcastId = await insertRunningBroadcast();
    await dripRunningBroadcasts();
    const recipient = (await recipientsOf(broadcastId))[0];
    await db().update(s.waOutbox).set({ wamid: "wamid.CAMP2", status: "SENT" }).where(eq(s.waOutbox.id, recipient.outboxId!));

    await runStatusEvent("wamid.CAMP2", "failed", [{ code: 131056, title: "تكرار سريع" }]);

    const after = (await recipientsOf(broadcastId))[0];
    expect(after.recipientStatus).toBe("FAILED");
    expect(after.errorCode).toBe("131056");
  });

  it("رتابة: delivered ثم failed لا تتراجع عن الحالة (failed متأخّرة بعد DELIVERED لا تُطبَّق)", async () => {
    await seedCustomer(1, "OPTED_IN");
    const broadcastId = await insertRunningBroadcast();
    await dripRunningBroadcasts();
    const recipient = (await recipientsOf(broadcastId))[0];
    await db().update(s.waOutbox).set({ wamid: "wamid.CAMP3", status: "SENT" }).where(eq(s.waOutbox.id, recipient.outboxId!));

    await runStatusEvent("wamid.CAMP3", "delivered");
    await runStatusEvent("wamid.CAMP3", "failed", [{ code: 500, title: "غير مرجَّح" }]);

    const after = (await recipientsOf(broadcastId))[0];
    expect(after.recipientStatus).toBe("DELIVERED"); // لا تراجع.
  });
});

describe("الإكمال — لا PENDING ⇒ COMPLETED (يشمل شريحة فارغة تماماً)", () => {
  it("لا عملاء مؤهّلون إطلاقاً (الكل OPTED_OUT/UNKNOWN) ⇒ COMPLETED فوراً بلا أي مستلم", async () => {
    await seedCustomer(1, "UNKNOWN");
    await seedCustomer(2, "OPTED_OUT");
    const broadcastId = await insertRunningBroadcast();

    await dripRunningBroadcasts();

    const row = await broadcastRow(broadcastId);
    expect(row.broadcastStatus).toBe("COMPLETED");
    expect(await recipientsOf(broadcastId)).toHaveLength(0);
  });
});

describe("idempotency — نداءان متتاليان بلا ازدواج", () => {
  it("لا يُدرِج مستلمين مكرَّرين (uq) ولا يُنشئ صفوف outbox مكرَّرة (dedupeKey)", async () => {
    for (let i = 1; i <= 5; i++) await seedCustomer(i, "OPTED_IN");
    const broadcastId = await insertRunningBroadcast({ throttlePerMinute: 2 });

    await dripRunningBroadcasts(); // يُدرج ٥ PENDING (مرّة واحدة)، يُقطِّر ٢.
    await dripRunningBroadcasts(); // إعادة الإدراج الكسول لا تُنفَّذ (صفوف موجودة أصلاً)؛ يُقطِّر ٢ إضافيَّين.

    const recipients = await recipientsOf(broadcastId);
    expect(recipients).toHaveLength(5); // لا ازدواج إدراج رغم دورتين.
    const phones = new Set(recipients.map((r) => r.phoneE164));
    expect(phones.size).toBe(5);

    const outbox = await outboxOf(broadcastId);
    expect(outbox).toHaveLength(4); // ٢+٢ — لا ازدواج إرسال.
    const dedupeKeys = new Set(outbox.map((o) => o.dedupeKey));
    expect(dedupeKeys.size).toBe(4);
  });
});

describe("broadcastResults — تجميع العدّ والنسب", () => {
  it("يُعيد counts/percentages مطابقة لحالة المستلمين الفعلية", async () => {
    for (let i = 1; i <= 4; i++) await seedCustomer(i, "OPTED_IN");
    const broadcastId = await insertRunningBroadcast({ throttlePerMinute: 10 });
    await dripRunningBroadcasts(); // ٤ مؤهّلون ⇒ كلّهم QUEUED ⇒ COMPLETED.

    const results = await broadcastResults(broadcastId);
    expect(results.totalRecipients).toBe(4);
    expect(results.counts.QUEUED).toBe(4);
    expect(results.percentages.QUEUED).toBe("100.00");
  });

  it("بثّ غير موجود ⇒ NOT_FOUND", async () => {
    await expect(broadcastResults(999999)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
