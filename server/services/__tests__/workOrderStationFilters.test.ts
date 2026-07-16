// workOrders.list — الترشيح الخادميّ لمحطة التنفيذ (statuses/assignedToMe/unassignedOnly).
//
// الخلل المُعالَج: المحطة كانت تجلب list({limit:200}) ثمّ تُصفّي محلّياً إلى «أوامري» و«الطابور
// العام». القائمة تُرتَّب desc(id) وتُقتطع بـlimit، والحالات النهائية (DELIVERED/CANCELLED)
// تتراكم بلا سقف ⇒ نافذة الـ٢٠٠ الأحدث تمتلئ بالتاريخ فيسقط **عملٌ نشط** من الشاشة **بصمت**
// (أمرٌ في الطابور لا يراه الفنّي = ضرر تشغيليّ لا مجرّد بطء). الثوابت:
//   م١) statuses يُرشّح خادمياً ⇒ العمل النشط كامل مهما تراكم التاريخ (سيناريو الاقتطاع فعلياً).
//   م٢) assignedToMe يعتمد هوية ctx حصراً — لا يقرأ فنّيٌّ أوامر زميله (منع IDOR).
//   م٣) unassignedOnly = الطابور العام (غير المُسنَد) فقط.
//   م٤) الفلاتر الجديدة **لا تتجاوز** عزل الفرع/الموظف القائم (تُضاف إليه لا تحلّ محلّه).
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import { createWorkOrder } from "../workOrderService";

const adminCtx = { req: { headers: {}, ip: "127.0.0.1" } as any, res: { cookie() {}, clearCookie() {} } as any, user: { id: 1, role: "admin", branchId: 1 } as any };
const opCtx = (id: number) => ({ req: { headers: {}, ip: "127.0.0.1" } as any, res: { cookie() {}, clearCookie() {} } as any, user: { id, role: "print_operator", branchId: 1 } as any });
const caller = (ctx: any = adminCtx) => appRouter.createCaller(ctx);

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "expenses", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders", "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderImages", "workOrderItems", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
  "auditLogs",
];
function db() { const d = getDb(); if (!d) throw new Error("no DB"); return d; }

beforeEach(async () => {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "المبيعات", code: "SALES", type: "SALES" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "op2", name: "فني ١", role: "print_operator", branchId: 1, loginMethod: "local" },
    { id: 3, openId: "op3", name: "فني ٢", role: "print_operator", branchId: 1, loginMethod: "local" },
  ]);
});

/** أمر شغل خدميّ خالص (لا يحتاج مخزوناً) بحالة/إسناد محدّدين. */
async function wo(opts: { title: string; branchId?: number; status?: string; assignedTo?: number | null }) {
  const r = await createWorkOrder(
    { branchId: opts.branchId ?? 1, baseVariantId: null, title: opts.title, salePrice: "100.00" },
    { userId: 1, branchId: opts.branchId ?? 1 },
  );
  const patch: Record<string, unknown> = {};
  if (opts.status) patch.status = opts.status;
  if (opts.assignedTo !== undefined) patch.assignedTo = opts.assignedTo;
  if (Object.keys(patch).length) {
    await db().update(s.workOrders).set(patch).where(sql`${s.workOrders.id} = ${r.workOrderId}`);
  }
  return r.workOrderId;
}

describe("workOrders.list — ترشيح محطة التنفيذ خادمياً", () => {
  it("م١: عملٌ نشط قديم يبقى ظاهراً رغم تراكم تاريخٍ أحدث يتجاوز limit (كان يسقط بصمت)", async () => {
    // أقدم أمر = نشط ومُسنَد لفنّي ١ ... ثمّ ١٢ أمراً مُسلَّماً أحدثَ منه.
    const oldActive = await wo({ title: "أمر نشط قديم", status: "IN_PROGRESS", assignedTo: 2 });
    const oldQueued = await wo({ title: "طابور قديم", status: "RECEIVED", assignedTo: null });
    for (let i = 0; i < 12; i++) await wo({ title: `مُسلَّم ${i}`, status: "DELIVERED", assignedTo: 3 });

    // محاكاة الاقتطاع: نافذة صغيرة (limit=5) تُمثّل نافذة ٢٠٠ الممتلئة بالتاريخ في الإنتاج.
    // السلوك القديم: list بلا ترشيح ثمّ تصفية محلّية ⇒ النشط القديم خارج النافذة = غير مرئيّ.
    const oldWay = await caller().workOrders.list({ limit: 5 });
    expect(oldWay.map((o) => o.id)).not.toContain(oldActive); // ← الخلل الأصلي موثَّقاً
    expect(oldWay.map((o) => o.id)).not.toContain(oldQueued);

    // السلوك الجديد: الترشيح خادميّ ⇒ النشط كامل رغم نفس الحدّ.
    const mine = await caller(opCtx(2)).workOrders.list({
      statuses: ["RECEIVED", "IN_PROGRESS", "READY"], assignedToMe: true, limit: 5,
    });
    expect(mine.map((o) => o.id)).toContain(oldActive);

    const queue = await caller().workOrders.list({ statuses: ["RECEIVED"], unassignedOnly: true, limit: 5 });
    expect(queue.map((o) => o.id)).toContain(oldQueued);
  });

  it("م١: statuses يستبعد الحالات النهائية (لا مُسلَّم/ملغى في قوائم المحطة)", async () => {
    await wo({ title: "مُسلَّم", status: "DELIVERED", assignedTo: 2 });
    await wo({ title: "ملغى", status: "CANCELLED", assignedTo: 2 });
    const active = await wo({ title: "جاهز", status: "READY", assignedTo: 2 });

    const mine = await caller(opCtx(2)).workOrders.list({
      statuses: ["RECEIVED", "IN_PROGRESS", "READY"], assignedToMe: true, limit: 100,
    });
    expect(mine.map((o) => o.id)).toEqual([active]);
  });

  it("م٢: assignedToMe من هوية ctx — فنّي ١ لا يرى أوامر فنّي ٢ (منع IDOR)", async () => {
    const forOp2 = await wo({ title: "لفني ١", status: "IN_PROGRESS", assignedTo: 2 });
    const forOp3 = await wo({ title: "لفني ٢", status: "IN_PROGRESS", assignedTo: 3 });

    const op2Sees = await caller(opCtx(2)).workOrders.list({ assignedToMe: true, limit: 100 });
    expect(op2Sees.map((o) => o.id)).toEqual([forOp2]);

    const op3Sees = await caller(opCtx(3)).workOrders.list({ assignedToMe: true, limit: 100 });
    expect(op3Sees.map((o) => o.id)).toEqual([forOp3]);
  });

  it("م٣: unassignedOnly = غير المُسنَد فقط (الطابور المشترك)", async () => {
    const free = await wo({ title: "حرّ", status: "RECEIVED", assignedTo: null });
    await wo({ title: "مسحوب", status: "RECEIVED", assignedTo: 3 });

    const queue = await caller().workOrders.list({ statuses: ["RECEIVED"], unassignedOnly: true, limit: 100 });
    expect(queue.map((o) => o.id)).toEqual([free]);
  });

  it("م٥ (انحدار #57): الفنّي يرى الطابور المشترك الذي أنشأه غيره — كان محجوباً بصمت", async () => {
    // أنشأه المستخدم ١ (كاشير/أدمن) ولم يُسنَد ⇒ يجب أن يراه الفنّي ليسحبه.
    // قبل الاستثناء: ownerCond (createdBy=2 OR assignedTo=2) يُخفيه ⇒ طابور فارغ أبداً.
    const free = await wo({ title: "طابور مشترك", status: "RECEIVED", assignedTo: null });
    const queue = await caller(opCtx(2)).workOrders.list({ statuses: ["RECEIVED"], unassignedOnly: true, limit: 100 });
    expect(queue.map((o) => o.id)).toEqual([free]);
  });

  it("م٥/حدّ: الاستثناء لا يكشف سجلّ موظفٍ آخر — المُسنَد لزميل يبقى محجوباً", async () => {
    await wo({ title: "لزميل", status: "RECEIVED", assignedTo: 3 });
    const free = await wo({ title: "حرّ", status: "RECEIVED", assignedTo: null });

    // الطابور المشترك: الحرّ فقط (أمر الزميل مُسنَد ⇒ له مالك ⇒ خارج الاستثناء).
    const queue = await caller(opCtx(2)).workOrders.list({ statuses: ["RECEIVED"], unassignedOnly: true, limit: 100 });
    expect(queue.map((o) => o.id)).toEqual([free]);

    // وبلا unassignedOnly يبقى عزل الموظف كما كان (لا يرى شيئاً — لا أنشأ ولا أُسنِد إليه).
    const normal = await caller(opCtx(2)).workOrders.list({ limit: 100 });
    expect(normal).toEqual([]);
  });

  it("م٤: الفلاتر لا تتجاوز عزل الفرع (أمر فرع ٢ لا يظهر لفنّي فرع ١)", async () => {
    const other = await wo({ title: "طابور فرع ٢", branchId: 2, status: "RECEIVED", assignedTo: null });
    const own = await wo({ title: "طابور فرع ١", branchId: 1, status: "RECEIVED", assignedTo: null });

    // الفنّي مقيَّد بفرعه (scopedBranchId=1) ⇒ لا يرى أمر فرع ٢ حتى مع unassignedOnly.
    const q = await caller(opCtx(2)).workOrders.list({ statuses: ["RECEIVED"], unassignedOnly: true, limit: 100 });
    expect(q.map((o) => o.id)).toContain(own);
    expect(q.map((o) => o.id)).not.toContain(other);
  });
});
