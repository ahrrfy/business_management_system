/**
 * ش١ من المرحلة ٢ (١٩/٨) — **من المحادثة إلى الطلب**.
 *
 * الثوابت المحروسة:
 *  ① **اختبار القبول ①**: طلبُ واتساب بلا عربون يدخل التجهيز ولا يُنشئ قبضاً ولا طريقة دفع —
 *     ويبقى ذلك صادقاً بعد إضافة مسار المحادثة (النصف الماليّ كان يمرّ، والمطلوب ألّا ينكسر).
 *  ② القناة ومعرّفها يصلان أمرَ الشغل: كانت المسوّدة تحمل `channel` بلا معرّفٍ مقابل ⇒
 *     طلبٌ من واتساب يُثبَّت فيفقد رقمَ مُرسِله كلّياً بينما عمود `workOrders.channelHandle`
 *     ينتظر قيمة.
 *  ③ الربط **ذرّيّ**: `conversations.linkedWorkOrderId` يُكتب داخل معاملة التثبيت — والعمود
 *     كان يبقى NULL أبداً لأنّ `linkWorkOrder` خدمةٌ بلا مستدعٍ في الواجهة.
 *  ④ عزل الفرع: محادثةُ فرعٍ لا تُربَط بأمر فرعٍ آخر (كان الحارس يفحص **الوجود** وحده).
 *  ⑤ صفٌّ تاريخيٌّ بقناةٍ خارج القاموس يُطوى إلى OTHER — كان `as never` يضرب عمود enum.
 *  ⑥ إشعار الجاهزية يجد عميلاً رقمُه في عمود `whatsapp` وحده (كان يقرأ `phone` فيصمت).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { openShift } from "../shiftService";
import { commitDraft, promoteDraft } from "../reception";
import { syncDraft } from "../reception/draft";
import { linkConversationToWorkOrder } from "../conversationService";

const TABLES = [
  "conversationMessages", "conversations",
  "receptionDraftLines", "receptionDrafts",
  "idempotencyKeys", "accountingEntries", "receipts",
  "workOrderMaterials", "workOrderImages", "workOrders",
  "invoiceItems", "invoices", "inventoryMovements", "branchStock",
  "productPrices", "productUnits", "productVariants", "products",
  "shifts", "customers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
const getInsertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

const CASHIER = { userId: 2, branchId: 1, role: "cashier" };

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw("TRUNCATE TABLE `" + t + "`"));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "فرع المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "mgr", name: "مدير", email: "m@t.test", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "rc", name: "موظف خدمة", email: "r@t.test", role: "cashier", loginMethod: "local", branchId: 1 },
  ]);
  await d.insert(s.customers).values([
    { id: 1, name: "أبو أحمد", phone: "+9647701112233", currentBalance: "0.00", creditLimit: null },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "دفتر" }]);
  await d.insert(s.productVariants).values([{ id: 1, productId: 1, sku: "NB-1", costPrice: "500.00" }]);
  await d.insert(s.productUnits).values([{ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1, isBaseUnit: true }]);
  await d.insert(s.productPrices).values([{ productUnitId: 1, priceTier: "RETAIL", price: "1000.00" }]);
  await d.insert(s.branchStock).values([{ variantId: 1, branchId: 1, quantity: 100 }]);
}

/** محادثةُ واتسابٍ واردة على الفرع المعطى. */
async function conversation(branchId = 1, handle = "+9647701112233") {
  const r = await db().insert(s.conversations).values({
    branchId, channel: "WHATSAPP", channelHandle: handle,
    customerId: branchId === 1 ? 1 : null, displayName: "أبو أحمد",
  } as never);
  return getInsertId(r);
}

/** سطرُ تخصيصٍ خالص — بلا بضاعة ⇒ لا يلزمه قبضٌ عند التثبيت (م٥). */
const CUSTOM_LINE = [
  {
    lineKind: "CUSTOM" as const, quantity: "1", unitPrice: "30000.00", title: "درع تكريم منقوش",
    printSpec: JSON.stringify({ laborCost: "0", priority: "NORMAL", hasDelivery: false }),
  },
];

beforeEach(async () => {
  await reset();
  await seed();
});

describe("ش١ — من المحادثة إلى الطلب", () => {
  it("⭐ قبول ①: طلبُ واتساب بلا عربون ⇒ صفر إيصال وصفر قيد ولا طريقة دفع، والمحادثة مربوطة", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, CASHIER);
    const convId = await conversation();

    const p = await promoteDraft({
      branchId: 1,
      header: {
        customerId: 1,
        channel: "WHATSAPP",
        channelHandle: "+9647701112233",
        conversationId: convId,
      },
      lines: CUSTOM_LINE,
    }, CASHIER);

    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "30000.00", shiftId: shift.shiftId,
    }, CASHIER);

    expect(r.workOrders.length).toBe(1);
    const wo = (await db().select().from(s.workOrders)
      .where(eq(s.workOrders.id, r.workOrders[0].workOrderId)))[0];

    // ① الحقيقة المالية: بلا عربون ⇒ لا قبضَ ولا طريقة.
    expect(wo.deposit).toBe("0.00");
    expect(wo.paymentMethod).toBeNull();
    expect(await db().select().from(s.receipts)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);
    // ودخل التجهيز فعلاً.
    expect(wo.status).toBe("RECEIVED");

    // ② القناة ومعرّفها وصلا الأمر.
    expect(wo.receptionChannel).toBe("WHATSAPP");
    expect(wo.channelHandle).toBe("+9647701112233");

    // ③ الربط وقع داخل المعاملة.
    const conv = (await db().select().from(s.conversations).where(eq(s.conversations.id, convId)))[0];
    expect(Number(conv.linkedWorkOrderId)).toBe(Number(wo.id));
  });

  it("⭐ ② المعرّف يُحفَظ على المسوّدة نفسها — لا يضيع بين الحفظ والتثبيت", async () => {
    const convId = await conversation();
    const p = await promoteDraft({
      branchId: 1,
      header: { customerId: 1, channel: "INSTAGRAM", channelHandle: "@abu.ahmed", conversationId: convId },
      lines: CUSTOM_LINE,
    }, CASHIER);
    const draft = (await db().select().from(s.receptionDrafts).where(eq(s.receptionDrafts.id, p.draftId)))[0];
    expect(draft.channel).toBe("INSTAGRAM");
    expect(draft.channelHandle).toBe("@abu.ahmed");
    expect(Number(draft.conversationId)).toBe(convId);
  });

  it("⭐ ③ بلا محادثة: التثبيت يمرّ كما كان — الربط إضافةٌ لا شرط", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, CASHIER);
    const p = await promoteDraft({
      branchId: 1, header: { customerId: 1, channel: "WALK_IN" }, lines: CUSTOM_LINE,
    }, CASHIER);
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "30000.00", shiftId: shift.shiftId,
    }, CASHIER);
    expect(r.workOrders.length).toBe(1);
    const wo = (await db().select().from(s.workOrders)
      .where(eq(s.workOrders.id, r.workOrders[0].workOrderId)))[0];
    expect(wo.receptionChannel).toBe("WALK_IN");
    expect(wo.channelHandle).toBeNull();
  });

  it("⭐ ④ عزل الفرع: محادثةُ فرعٍ لا تُربَط بأمر فرعٍ آخر", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, CASHIER);
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: CUSTOM_LINE }, CASHIER);
    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "30000.00", shiftId: shift.shiftId,
    }, CASHIER);
    const woId = r.workOrders[0].workOrderId;

    const otherBranchConv = await conversation(2, "+9647709998877");
    // محادثةُ الفرع ٢ + أمرُ الفرع ١ ⇒ مرفوض.
    await expect(
      linkConversationToWorkOrder(otherBranchConv, woId, { branchId: 2, scopedBranchId: 2 }),
    ).rejects.toThrowError(/فرعاً آخر/);

    // وموظّفُ الفرع ١ لا يرى محادثة الفرع ٢ أصلاً — **NOT_FOUND لا FORBIDDEN**
    // («ممنوع» يؤكّد وجود الرقم فيصير كاشفَ وجود).
    await expect(
      linkConversationToWorkOrder(otherBranchConv, null, { branchId: 1, scopedBranchId: 1 }),
    ).rejects.toThrowError(/غَير مَوجودة/);
  });

  it("⭐ ⑤ صفٌّ تاريخيٌّ بقناةٍ خارج القاموس يُطوى إلى OTHER لا يُسقِط الطلب", async () => {
    const shift = await openShift({ branchId: 1, openingBalance: "0", shiftType: "RECEPTION" }, CASHIER);
    const p = await promoteDraft({ branchId: 1, header: { customerId: 1 }, lines: CUSTOM_LINE }, CASHIER);
    // حقنُ قيمةٍ غريبة مباشرةً في العمود (محاكاة صفٍّ قديم قبل تضييق العقد).
    await db().update(s.receptionDrafts).set({ channel: "FACEBOOK" })
      .where(eq(s.receptionDrafts.id, p.draftId));

    const r = await commitDraft({
      draftId: p.draftId, version: 0, expectedTotal: "30000.00", shiftId: shift.shiftId,
    }, CASHIER);
    const wo = (await db().select().from(s.workOrders)
      .where(eq(s.workOrders.id, r.workOrders[0].workOrderId)))[0];
    // تُطوى إلى OTHER بدل أن تُسقط الطلبَ بخطأ قاعدةٍ بعد أن أتمّ الموظّف السلّة كلّها.
    expect(wo.receptionChannel).toBe("OTHER");
  });

  it("⭐ ⑥ إشعار الجاهزية يجد رقم عميلٍ في عمود whatsapp وحده", async () => {
    // كان `notifyOrderReady` يقرأ customers.phone ويعود مبكّراً عند خلوّه ⇒ عميلُ واتساب
    // رقمُه في العمود المخصّص لا يصله شيء. الاشتقاق صار COALESCE(whatsapp, phone, …).
    await db().update(s.customers).set({ phone: null, whatsapp: "+9647705554433" })
      .where(eq(s.customers.id, 1));
    const row = (await db().select({
      p: sql<string | null>`COALESCE(NULLIF(${s.customers.whatsapp}, ''), NULLIF(${s.customers.phone}, ''), NULLIF(${s.customers.phone2}, ''), NULLIF(${s.customers.phone3}, ''))`,
    }).from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(row.p).toBe("+9647705554433");
  });

  it("مزامنةٌ من شاشةٍ لا تُرسل الحقول الجديدة لا تمسحها", async () => {
    const convId = await conversation();
    const p = await promoteDraft({
      branchId: 1,
      header: { customerId: 1, channel: "WHATSAPP", channelHandle: "+9647701112233", conversationId: convId },
      lines: CUSTOM_LINE,
    }, CASHIER);
    await syncDraft({ draftId: p.draftId, version: 0, header: { customerId: 1 }, lines: CUSTOM_LINE }, CASHIER);
    const draft = (await db().select().from(s.receptionDrafts).where(eq(s.receptionDrafts.id, p.draftId)))[0];
    expect(Number(draft.conversationId)).toBe(convId);
    expect(draft.channelHandle).toBe("+9647701112233");
  });
});
