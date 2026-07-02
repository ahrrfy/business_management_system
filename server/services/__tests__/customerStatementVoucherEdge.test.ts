/**
 * F5 (تدقيق ٢/٧) — الحافّة (ب): تحقيب كشف حساب العميل عند السند الملغى/المعلّق.
 *
 * الثابت: openingBalance + Σ(حركة الفترة) === currentBalance. مع `from` بعد كل الحركة (فترة فارغة)
 * ⇒ openingBalance يجب أن يساوي currentBalance بالضبط.
 *
 * الكسر (قبل الإصلاح): customerOpeningBalance.payRow كان يفلتر `status='COMPLETED'` فقط ⇒
 *  (ب-١) سند مُعتمَد ثم ملغى: يُستبعَد الأصل REVERSED ويُحتسَب تعويضه COMPLETED ⇒ ساق واحدة (opening
 *        منحرف بمقدار السند بإشارة معاكسة — دين/ائتمان وهميّ).
 *  (ب-٢) سند معلّق PENDING_APPROVAL: status=COMPLETED فيُحتسَب رغم أنه لم يمسّ currentBalance.
 * الإصلاح: payRow يجمع الإيصالات التي أثّرت فعلاً على الرصيد = `status IN ('COMPLETED','REVERSED')
 *          AND approvalStatus='APPROVED'` ⇒ الأصل REVERSED يوازن تعويضه (الزوج=صفر)، والمعلّق يُستبعَد.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createVoucher } from "../voucher/create";
import { cancelVoucher } from "../voucher/cancel";
import { createWorkOrder } from "../workOrder/create";
import { startWorkOrder, markWorkOrderReady } from "../workOrder/lifecycle";
import { deliverWorkOrder } from "../workOrder/deliver";
import { getCustomerStatement } from "../reports/arAging";
import { money } from "../money";

const admin = { userId: 1, branchId: 1, role: "admin" as const };
const OLD = new Date("2020-01-01T00:00:00.000Z");
const FROM = "2021-01-01";

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "voucherCategories",
  "invoiceItems", "invoices", "workOrderImages", "workOrderMaterials", "workOrders",
  "shifts", "customers", "branches", "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}
async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}
async function seed() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "local_admin", name: "admin", role: "admin", loginMethod: "local", branchId: 1 });
  await d.insert(s.customers).values({ id: 1, name: "عميل", defaultPriceTier: "RETAIL", currentBalance: "0", creditLimit: "1000000" });
  await d.insert(s.shifts).values({ id: 1, userId: 1, branchId: 1, status: "OPEN", openedAt: new Date(), openGuard: "1:1", openingBalance: "0" });
}
async function currentBalance(): Promise<string> {
  return String((await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0].currentBalance);
}
async function backdateCustomerReceipts() {
  await db().update(s.receipts).set({ createdAt: OLD }).where(eq(s.receipts.partyId, 1));
}

beforeEach(async () => { await reset(); await seed(); });

describe("F5 حافّة (ب) — كشف العميل يتّزن مع السند الملغى/المعلّق", () => {
  it("(ب-١) سند قبض مُعتمَد ثم ملغى ⇒ openingBalance = currentBalance = 0 (لا ساق واحدة)", async () => {
    const v = await createVoucher(
      { voucherType: "RECEIPT", branchId: 1, amount: "50.00", paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1, description: "دفعة على الحساب" },
      admin,
    );
    // مُعتمَد فوراً (50 < عتبة الاعتماد) ⇒ currentBalance = −50.
    expect(await currentBalance()).toBe("-50.00");
    await cancelVoucher(v.receiptId, admin);
    // الإلغاء يعكس ⇒ currentBalance = 0.
    expect(await currentBalance()).toBe("0.00");
    // الأصل REVERSED والتعويضي COMPLETED كلاهما قبل الفترة.
    await backdateCustomerReceipts();

    const stmt = await getCustomerStatement(1, { from: FROM });
    expect(stmt).not.toBeNull();
    // الفترة فارغة (لا حركة بعد FROM) ⇒ المُرحَّل = الرصيد الجاري = 0. الكسر كان يُظهر 50.
    expect(stmt!.summary.openingBalance).toBe("0.00");
    expect(stmt!.summary.currentBalance).toBe("0.00");
  });

  it("(ب-٢) سند معلّق PENDING_APPROVAL (لم يمسّ الرصيد) ⇒ لا يُحتسَب في المُرحَّل", async () => {
    const prev = process.env.VOUCHER_APPROVAL_THRESHOLD_IQD;
    process.env.VOUCHER_APPROVAL_THRESHOLD_IQD = "10"; // 50 ≥ 10 ⇒ يحتاج اعتماد ⇒ PENDING
    try {
      const v = await createVoucher(
        { voucherType: "RECEIPT", branchId: 1, amount: "50.00", paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1, description: "دفعة معلّقة" },
        admin,
      );
      expect(v.approvalStatus).toBe("PENDING_APPROVAL");
    } finally {
      if (prev === undefined) delete process.env.VOUCHER_APPROVAL_THRESHOLD_IQD;
      else process.env.VOUCHER_APPROVAL_THRESHOLD_IQD = prev;
    }
    // السند المعلّق لم يمسّ currentBalance (يبقى 0).
    expect(await currentBalance()).toBe("0.00");
    await backdateCustomerReceipts();

    const stmt = await getCustomerStatement(1, { from: FROM });
    // المعلّق (approvalStatus≠APPROVED) يُستبعَد ⇒ المُرحَّل = 0 = الرصيد الجاري. الكسر كان −50.
    expect(stmt!.summary.openingBalance).toBe("0.00");
    expect(stmt!.summary.currentBalance).toBe("0.00");
  });

  it("(ضبط) دفعة سند مُعتمَدة قبل الفترة (لم تُلغَ) ⇒ تُحتسَب طبيعياً (لا انحدار على الدفعات العادية)", async () => {
    await createVoucher(
      { voucherType: "RECEIPT", branchId: 1, amount: "30.00", paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1, description: "دفعة" },
      admin,
    );
    expect(await currentBalance()).toBe("-30.00");
    await backdateCustomerReceipts();
    const stmt = await getCustomerStatement(1, { from: FROM });
    // دفعة IN مُعتمَدة قبل الفترة ⇒ opening = −30 = currentBalance (الدفعة تخفض الذمة).
    expect(stmt!.summary.openingBalance).toBe("-30.00");
    expect(stmt!.summary.currentBalance).toBe("-30.00");
  });
});

describe("F5 حافّة (أ) — عربون منقول عبر حدّ الفترة: الثابت صامد (حارس انحدار)", () => {
  it("عربون ٣٠٠ قبل الفترة ثم تسليم أمر شغل (فاتورة ١٠٠٠ داخل الفترة) ⇒ opening=−300 والثابت يتّزن مع currentBalance=700", async () => {
    const wo = await createWorkOrder(
      { branchId: 1, customerId: 1, title: "طباعة", salePrice: "1000.00", deposit: "300.00", paymentMethod: "CASH", clientRequestId: "wo-a" },
      admin,
    );
    // العربون لا يمسّ currentBalance عند الإنشاء (يُحتسَب كدفعة على الفاتورة عند التسليم فقط).
    expect(await currentBalance()).toBe("0.00");
    // اضبط تاريخ إيصال العربون قبل الفترة (محاكاة: دُفع سابقاً). الثابت يعتمد على بقاء createdAt هذا.
    await db().update(s.receipts).set({ createdAt: OLD }).where(eq(s.receipts.workOrderId, wo.workOrderId));

    await startWorkOrder(wo.workOrderId, admin);
    await markWorkOrderReady(wo.workOrderId, admin);
    await deliverWorkOrder({ workOrderId: wo.workOrderId }, admin);
    // التسليم: فاتورة ١٠٠٠، العربون ٣٠٠ مضموم ⇒ الذمة ترتفع بالجزء غير المدفوع = 700.
    expect(await currentBalance()).toBe("700.00");

    const stmt = await getCustomerStatement(1, { from: FROM });
    expect(stmt).not.toBeNull();
    // العربون (createdAt=OLD<FROM) في المُرحَّل سلبياً، لا يظهر كدفعة داخل الفترة؛ الفاتورة (اليوم≥FROM) في الفترة.
    expect(stmt!.summary.openingBalance).toBe("-300.00");
    expect(stmt!.summary.currentBalance).toBe("700.00");
    const depositShown = stmt!.payments.some((p) => Number(p.amount) === 300);
    expect(depositShown).toBe(false); // العربون خارج الفترة المعروضة

    // الثابت الشامل: openingBalance + Σ(فواتير معروضة) − Σ(دفعات معروضة صافية IN−OUT) = currentBalance.
    const shownInvTotal = stmt!.invoices.filter((i) => i.status !== "CANCELLED").reduce((t, i) => t + Number(i.total), 0);
    const shownPayNet = stmt!.payments.reduce((t, p) => t + (p.direction === "IN" ? Number(p.amount) : -Number(p.amount)), 0);
    expect(money(stmt!.summary.openingBalance).plus(shownInvTotal).minus(shownPayNet).toFixed(2)).toBe(stmt!.summary.currentBalance);
  });
});
