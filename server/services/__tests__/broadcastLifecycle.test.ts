// دورة حياة البث التسويقي (S5، T5.1) — broadcastService: معاينة العدد/الكلفة، إنشاء بشرط قالب
// MARKETING+APPROVED، إطلاق باعتماد ثانٍ (SOD) فوق عتبة الجمهور، وKill Switch:
//  1) previewAudience: العدد + الكلفة = count × MARKETING_MSG_COST.
//  2) createBroadcast: قالب غير MARKETING أو غير APPROVED ⇒ رفض؛ قالب صالح ⇒ DRAFT بلقطة مطابقة للمعاينة.
//  3) launchBroadcast: جمهور > العتبة ⇒ PENDING_APPROVAL (لا RUNNING)؛ ≤ العتبة ⇒ RUNNING فوراً.
//  4) approveBroadcast: SOD صارم بلا استثناء admin — نفس المُنشئ (حتى admin) ⇒ FORBIDDEN؛ فاعل آخر ⇒ RUNNING.
//  5) killSwitch مفعّل ⇒ رفض الإطلاق/الاعتماد بـBAD_REQUEST.
//  6) (مراجعة T5.1) عزل فرع الشريحة: broadcastsRouter.preview/create يفرضان segment.branchId=فرع
//     المستخدم لغير الأدمن (resolveSegmentBranch) — الأدمن وحده يستهدف فرعاً آخر أو الكلّ.
//  7) (مراجعة T5.1) فحص الفرع قبل فحص الحالة: assertBroadcastBranchAccess ينفَّذ في launch/approve
//     قبل أي رسالة تكشف حالة البثّ — مستخدم فرعٍ آخر يُصدَم بـFORBIDDEN لا BAD_REQUEST.
//  8) (مراجعة T5.1) minSpend في rfm لا يقبل قيمة سالبة (nonNegMoneyString).
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { money, toDbMoney } from "../money";
import type { Actor } from "../tx";
import {
  MARKETING_MSG_COST,
  approveBroadcast,
  createBroadcast,
  launchBroadcast,
  previewAudience,
  type CreateBroadcastInput,
} from "../whatsapp/broadcastService";

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

// invoices: مطلوبة لاختبارات عزل فرع الشريحة أدناه (RFM حيّ) — يجب تفريغها أيضاً بين الاختبارات
// (FOREIGN_KEY_CHECKS=0 أثناء التفريغ فالترتيب مع customers/branches غير مهمّ).
const TABLES = ["waBroadcastRecipients", "waBroadcasts", "waTemplates", "waHubSettings", "invoices", "customers", "users", "branches"];

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

const managerA: Actor = { userId: 2, branchId: 1, role: "manager" };
const managerB: Actor = { userId: 3, branchId: 1, role: "manager" };
const adminActor: Actor = { userId: 1, branchId: 1, role: "admin" };

async function seedBase(opts: { campaignApprovalThreshold?: number; killSwitch?: boolean } = {}) {
  await db().insert(s.branches).values([{ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" }]);
  await db().insert(s.users).values([
    { id: 1, openId: "admin", name: "المدير العام", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "mgrA", name: "مديرة أ", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "mgrB", name: "مدير ب", role: "manager", loginMethod: "local", branchId: 1 },
  ]);
  await db().insert(s.waHubSettings).values({
    id: 1,
    campaignApprovalThreshold: opts.campaignApprovalThreshold ?? 500,
    killSwitch: opts.killSwitch ?? false,
  });
  await db().insert(s.waTemplates).values([
    { id: 1, name: "promo_sale", language: "ar", category: "MARKETING", templateStatus: "APPROVED", bodyText: "عرض خاص لك {{1}}", variableCount: 1 },
    { id: 2, name: "order_ready", language: "ar", category: "UTILITY", templateStatus: "APPROVED", bodyText: "طلبك جاهز" },
    { id: 3, name: "promo_draft", language: "ar", category: "MARKETING", templateStatus: "PENDING", bodyText: "قيد المراجعة" },
  ]);
}

async function seedCustomers(count: number, startId = 1) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    name: `عميل ${startId + i}`,
    phone: `07${String(70000000 + startId + i).padStart(9, "0")}`,
    customerType: "فرد" as const,
  }));
  await db().insert(s.customers).values(rows);
}

/** استدعاء إجراءات broadcastsRouter كـActor فعليّ (appRouter.createCaller) — نمط rbacHardening.test.ts.
 *  sessionId/platformAdmin غير مطلوبين فعلياً هنا (الراوترات المستهدَفة لا تلمسهما)، والملف مُستثنًى
 *  من tsc (**\/*.test.ts) فلا حاجة لمطابقة TrpcContext الكاملة بدقّة. */
function ctxFor(actor: Actor): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: {
      id: actor.userId,
      role: actor.role,
      branchId: actor.branchId,
      name: "t",
      email: `u${actor.userId}@t`,
      isActive: true,
    } as unknown as TrpcContext["user"],
  } as unknown as TrpcContext;
}
const routerCaller = (actor: Actor) => appRouter.createCaller(ctxFor(actor));

// branchId:1 مطابق لفرع managerA/managerB/adminActor أدناه (كلّهم فرع ١) — مطلوب بعد إصلاح T5.1
// (assertSegmentBranchMatchesActor في broadcastService.ts): هذه الاختبارات تستدعي الخدمة مباشرةً
// متجاوزةً حقن الفرع التلقائي في broadcastsRouter.ts (resolveSegmentBranch)، فيجب ضبط
// segment.branchId يدوياً هنا كي يطابق فرع الفاعل غير الأدمن عند launch/approve.
const baseSegment = { customerTypes: ["فرد"], branchId: 1 };

function baseCreateInput(overrides: Partial<CreateBroadcastInput> = {}): CreateBroadcastInput {
  return {
    name: "حملة العروض",
    branchId: 1,
    templateId: 1,
    segment: baseSegment,
    ...overrides,
  };
}

beforeEach(async () => {
  await reset();
});

describe("previewAudience", () => {
  it("العدد + الكلفة = count × MARKETING_MSG_COST", async () => {
    await seedBase();
    await seedCustomers(4);
    const res = await previewAudience(baseSegment);
    expect(res.audienceCount).toBe(4);
    expect(res.costEstimate).toBe(toDbMoney(money(MARKETING_MSG_COST).mul(4)));
  });

  it("شريحة فارغة ⇒ عدد صفر وكلفة صفر", async () => {
    await seedBase();
    const res = await previewAudience({ customerTypes: ["حكومي"] });
    expect(res.audienceCount).toBe(0);
    expect(res.costEstimate).toBe("0.00");
  });
});

describe("createBroadcast", () => {
  it("قالب ليس من فئة MARKETING ⇒ رفض BAD_REQUEST", async () => {
    await seedBase();
    await seedCustomers(2);
    await expect(createBroadcast(baseCreateInput({ templateId: 2 }), managerA)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("قالب MARKETING لكن غير APPROVED (PENDING) ⇒ رفض BAD_REQUEST", async () => {
    await seedBase();
    await seedCustomers(2);
    await expect(createBroadcast(baseCreateInput({ templateId: 3 }), managerA)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("قالب صالح (MARKETING+APPROVED) ⇒ DRAFT بلقطة audienceCount/costEstimate مطابقة للمعاينة", async () => {
    await seedBase();
    await seedCustomers(6);
    const preview = await previewAudience(baseSegment);
    const res = await createBroadcast(baseCreateInput(), managerA);
    expect(res.audienceCount).toBe(preview.audienceCount);
    expect(res.costEstimate).toBe(preview.costEstimate);

    const row = (await db().select().from(s.waBroadcasts).where(sql`id = ${res.broadcastId}`))[0];
    expect(row.broadcastStatus).toBe("DRAFT");
    expect(row.createdBy).toBe(managerA.userId);
    expect(Number(row.audienceCount)).toBe(6);
  });
});

describe("launchBroadcast — عتبة الاعتماد", () => {
  it("جمهور > العتبة ⇒ PENDING_APPROVAL (لا يُطلَق)", async () => {
    await seedBase({ campaignApprovalThreshold: 3 });
    await seedCustomers(5);
    const created = await createBroadcast(baseCreateInput(), managerA);
    const res = await launchBroadcast(created.broadcastId, managerA);
    expect(res.status).toBe("PENDING_APPROVAL");
    const row = (await db().select().from(s.waBroadcasts).where(sql`id = ${created.broadcastId}`))[0];
    expect(row.broadcastStatus).toBe("PENDING_APPROVAL");
    expect(row.startedAt).toBeNull();
  });

  it("جمهور ≤ العتبة ⇒ RUNNING فوراً + startedAt", async () => {
    await seedBase({ campaignApprovalThreshold: 10 });
    await seedCustomers(3);
    const created = await createBroadcast(baseCreateInput(), managerA);
    const res = await launchBroadcast(created.broadcastId, managerA);
    expect(res.status).toBe("RUNNING");
    const row = (await db().select().from(s.waBroadcasts).where(sql`id = ${created.broadcastId}`))[0];
    expect(row.broadcastStatus).toBe("RUNNING");
    expect(row.startedAt).not.toBeNull();
  });

  it("إطلاق ثانٍ لبثٍّ RUNNING بالفعل ⇒ BAD_REQUEST", async () => {
    await seedBase({ campaignApprovalThreshold: 10 });
    await seedCustomers(1);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA);
    await expect(launchBroadcast(created.broadcastId, managerA)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("approveBroadcast — فصل المهام (SOD) صارم بلا استثناء admin", () => {
  it("نفس المُنشئ (مدير) يحاول اعتماد بثّه ⇒ FORBIDDEN", async () => {
    await seedBase({ campaignApprovalThreshold: 3 });
    await seedCustomers(5);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA); // ⇒ PENDING_APPROVAL
    await expect(approveBroadcast(created.broadcastId, managerA)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("مدير آخر يعتمد ⇒ RUNNING + approvedBy", async () => {
    await seedBase({ campaignApprovalThreshold: 3 });
    await seedCustomers(5);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA);
    const res = await approveBroadcast(created.broadcastId, managerB);
    expect(res.status).toBe("RUNNING");
    const row = (await db().select().from(s.waBroadcasts).where(sql`id = ${created.broadcastId}`))[0];
    expect(row.broadcastStatus).toBe("RUNNING");
    expect(row.approvedBy).toBe(managerB.userId);
    expect(row.startedAt).not.toBeNull();
  });

  it("admin يحاول اعتماد بثّه الخاصّ ⇒ FORBIDDEN أيضاً (بلا استثناء، خلافاً لنمط السندات)", async () => {
    await seedBase({ campaignApprovalThreshold: 3 });
    await seedCustomers(5);
    const created = await createBroadcast(baseCreateInput(), adminActor);
    await launchBroadcast(created.broadcastId, adminActor);
    await expect(approveBroadcast(created.broadcastId, adminActor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // admin آخر (لو وُجد) أو مدير مختلف يستطيع الاعتماد — نتحقّق أن مديراً مختلفاً ينجح.
    const res = await approveBroadcast(created.broadcastId, managerA);
    expect(res.status).toBe("RUNNING");
  });

  it("اعتماد بثّ ليس بانتظار الموافقة ⇒ BAD_REQUEST", async () => {
    await seedBase({ campaignApprovalThreshold: 10 });
    await seedCustomers(2);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA); // ⇒ RUNNING مباشرة (ضمن العتبة)
    await expect(approveBroadcast(created.broadcastId, managerB)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("killSwitch — يوقف الإطلاق/الاعتماد الآليّ كليّاً", () => {
  it("killSwitch مفعّل ⇒ رفض الإطلاق بـBAD_REQUEST", async () => {
    await seedBase({ campaignApprovalThreshold: 10, killSwitch: true });
    await seedCustomers(2);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await expect(launchBroadcast(created.broadcastId, managerA)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("killSwitch مفعّل ⇒ رفض الاعتماد أيضاً بـBAD_REQUEST", async () => {
    // نُفعّل الإطلاق أولاً (Kill Switch مطفأ) ليصل PENDING_APPROVAL، ثم نُفعّل Kill Switch ونحاول الاعتماد.
    await seedBase({ campaignApprovalThreshold: 3, killSwitch: false });
    await seedCustomers(5);
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA); // ⇒ PENDING_APPROVAL
    await db().update(s.waHubSettings).set({ killSwitch: true }).where(sql`id = 1`);
    await expect(approveBroadcast(created.broadcastId, managerB)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ── مراجعة T5.1: إصلاح ١ (Important) — عزل فرع الشريحة ───────────────────────────────────────
// segment.branchId (يبني جمهور RFM من invoices) كان غير مُصفّى بموازاة فرع المستخدم الإداري ⇒
// مديرُ فرعٍ ١ يستطيع معاينة/إنشاء بثّ جمهوره محسوباً من فواتير فرع ٢ رغم كونه بلا صلاحية إدارته.
async function seedTwoBranchInvoices() {
  await seedBase();
  await db().insert(s.branches).values([{ id: 2, name: "الفرع الآخر", code: "BR2", type: "SALES" }]);
  await db().insert(s.customers).values([{ id: 50, name: "عميل متعدّد الفروع", phone: "07709990000", customerType: "فرد" }]);
  // ٦ فواتير على الفرع ٢ (ليس فرع managerA) — تكفي عتبة minInvoices=5 لو حُسبت هناك خطأً.
  for (let i = 0; i < 6; i++) {
    await db().insert(s.invoices).values({
      invoiceNumber: `INV-ISO-B2-${i}`,
      sourceType: "POS",
      branchId: 2,
      customerId: 50,
      subtotal: "10000",
      total: "10000",
      status: "PAID" as any,
      invoiceDate: new Date(),
    });
  }
  // فاتورتان فقط على الفرع ١ (فرع managerA الحقيقي) — لا تكفي عتبة minInvoices=5.
  for (let i = 0; i < 2; i++) {
    await db().insert(s.invoices).values({
      invoiceNumber: `INV-ISO-B1-${i}`,
      sourceType: "POS",
      branchId: 1,
      customerId: 50,
      subtotal: "10000",
      total: "10000",
      status: "PAID" as any,
      invoiceDate: new Date(),
    });
  }
}

describe("عزل فرع الشريحة عبر الراوتر (مراجعة T5.1، إصلاح ١) — broadcasts.preview/create", () => {
  it("مدير فرع ١ يطلب segment.branchId=٢ ⇒ يُتجاهَل ويُحسَب الجمهور من فرعه ١ فقط (لا ٢)", async () => {
    await seedTwoBranchInvoices();
    // لو نُفِّذ الطلب فعلياً على الفرع ٢ (كما أرسله العميل) لطابق العميل ٥٠ (٦ فواتير ≥ ٥) والعدد=١.
    const res = await routerCaller(managerA).broadcasts.preview({
      segment: { branchId: 2, rfm: { minInvoices: 5 } },
    });
    expect(res.audienceCount).toBe(0);
  });

  it("مدير فرع ١ بلا segment.branchId مُرسَل ⇒ نفس النتيجة (فرعه يُفرَض دائماً لا يُترَك بلا فلترة)", async () => {
    await seedTwoBranchInvoices();
    const res = await routerCaller(managerA).broadcasts.preview({ segment: { rfm: { minInvoices: 5 } } });
    expect(res.audienceCount).toBe(0);
  });

  it("الأدمن يستهدف فرع ٢ صراحةً ⇒ يُحترَم طلبه (١ يطابق)", async () => {
    await seedTwoBranchInvoices();
    const res = await routerCaller(adminActor).broadcasts.preview({
      segment: { branchId: 2, rfm: { minInvoices: 5 } },
    });
    expect(res.audienceCount).toBe(1);
  });

  it("create: يُخزَّن segmentJson.branchId=فرع المدير (١) لا الفرع المطلوب (٢)، وaudienceCount يطابق فرعه", async () => {
    await seedTwoBranchInvoices();
    const res = await routerCaller(managerA).broadcasts.create({
      name: "بثّ محاولة اختراق فرع",
      branchId: 1,
      templateId: 1,
      segment: { branchId: 2, rfm: { minInvoices: 5 } },
    });
    expect(res.audienceCount).toBe(0);
    const row = (await db().select().from(s.waBroadcasts).where(sql`id = ${res.broadcastId}`))[0];
    expect((row.segmentJson as { branchId?: number | null }).branchId).toBe(1);
  });
});

// ── مراجعة T5.1: إصلاح ١ — التأكيد الدفاعي في launch/approve (segmentJson مقابل فرع الفاعل) ────
describe("التأكيد الدفاعي: segmentJson.branchId يجب أن يطابق فرع الفاعل غير الأدمن", () => {
  it("صفّ محاكٍ لسابق الإصلاح (segmentJson.branchId=٢ رغم أن row.branchId=١ فرع الفاعل) ⇒ FORBIDDEN عند الإطلاق", async () => {
    await seedBase({ campaignApprovalThreshold: 100 });
    await seedCustomers(2);
    // إنشاء مباشر عبر الخدمة (يتجاوز حقن الراوتر) — يحاكي صفّاً قديماً بمعايير مختلفة عن فرع البثّ.
    const created = await createBroadcast(
      baseCreateInput({ segment: { customerTypes: ["فرد"], branchId: 2 } }),
      managerA,
    );
    await expect(launchBroadcast(created.broadcastId, managerA)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("الأدمن يتجاوز التأكيد الدفاعي حتى مع segmentJson.branchId مختلف", async () => {
    await seedBase({ campaignApprovalThreshold: 100 });
    await seedCustomers(2);
    const created = await createBroadcast(
      baseCreateInput({ branchId: null, segment: { customerTypes: ["فرد"], branchId: 2 } }),
      adminActor,
    );
    const res = await launchBroadcast(created.broadcastId, adminActor);
    expect(res.status).toBe("RUNNING");
  });
});

// ── مراجعة T5.1: إصلاح ٢ (Minor) — فحص الفرع قبل فحص الحالة ─────────────────────────────────
describe("فحص الفرع قبل فحص الحالة (مراجعة T5.1، إصلاح ٢)", () => {
  async function seedOtherBranchManager(): Promise<Actor> {
    await db().insert(s.branches).values([{ id: 2, name: "فرع آخر", code: "BR2", type: "SALES" }]);
    await db().insert(s.users).values([{ id: 4, openId: "mgrC", name: "مدير فرع آخر", role: "manager", loginMethod: "local", branchId: 2 }]);
    return { userId: 4, branchId: 2, role: "manager" };
  }

  it("launchBroadcast: مستخدم فرعٍ آخر على بثّ RUNNING بالفعل ⇒ FORBIDDEN لا BAD_REQUEST (لا يكشف الحالة)", async () => {
    await seedBase({ campaignApprovalThreshold: 100 });
    await seedCustomers(1);
    const managerOtherBranch = await seedOtherBranchManager();
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA); // ⇒ RUNNING (ضمن العتبة)
    // لولا الإصلاح: فحص الحالة يسبق فحص الفرع فيرمي BAD_REQUEST "لا يمكن إطلاق بثّ بحالة RUNNING"
    // (يُسرّب وجود/حالة البثّ لمستخدم فرعٍ آخر). بعد الإصلاح: FORBIDDEN فوراً بلا كشف حالة.
    await expect(launchBroadcast(created.broadcastId, managerOtherBranch)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("approveBroadcast: مستخدم فرعٍ آخر على بثّ RUNNING (ليس بانتظار اعتماد) ⇒ FORBIDDEN لا BAD_REQUEST", async () => {
    await seedBase({ campaignApprovalThreshold: 100 });
    await seedCustomers(1);
    const managerOtherBranch = await seedOtherBranchManager();
    const created = await createBroadcast(baseCreateInput(), managerA);
    await launchBroadcast(created.broadcastId, managerA); // ⇒ RUNNING مباشرة (ليس PENDING_APPROVAL)
    await expect(approveBroadcast(created.broadcastId, managerOtherBranch)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ── مراجعة T5.1: إصلاح ٣ (Minor) — minSpend غير سالب ─────────────────────────────────────────
describe("minSpend لا يقبل قيمة سالبة (مراجعة T5.1، إصلاح ٣)", () => {
  it("preview: minSpend سالب ⇒ رفض BAD_REQUEST عند التحقّق من المدخلات", async () => {
    await seedBase();
    await expect(
      routerCaller(managerA).broadcasts.preview({ segment: { rfm: { minSpend: "-500" } } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("preview: minSpend=0 (عتبة غير سالبة صفرية) لا يزال يُقبَل ولا يستبعد أحداً", async () => {
    await seedBase();
    await seedCustomers(1);
    const res = await routerCaller(managerA).broadcasts.preview({ segment: { rfm: { minSpend: "0" } } });
    expect(res.audienceCount).toBe(1);
  });
});
