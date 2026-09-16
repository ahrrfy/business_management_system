/* ============================================================================
 * خدمة سلف الموظفين — وحدة الموارد البشرية (server/services/advancesService.ts) — بند 12ج (٧/٧)
 *
 * الدورة المالية:
 *  - grantAdvance: سند صرف حقيقي (OUT من الخزينة عبر createVoucher القائمة — فئة «رواتب»)
 *    ثم صفّ سلفة ACTIVE بـremaining = amount مربوط بالسند (receiptId).
 *  - suggestDeductions: لكل موظف بسلفة ACTIVE يُقترح استقطاع الشهر من **أقدم** سلفة نشطة:
 *    suggested = min(monthlyDeduction ?? remaining، remaining) — سلفة واحدة تلو الأخرى حتى تسويتها.
 *  - settleAdvancesOnPayTx (يستدعيها payRun): تُنقص remaining بالأقدم أولاً بمقدار
 *    payrollItems.advanceDeduction المصروف فعلاً؛ بلوغ الصفر ⇒ SETTLED.
 *  - cancelAdvance: فقط قبل أي خصم (remaining == amount) ⇒ CANCELLED. **لا يعكس سند الصرف
 *    الأصلي آلياً** — النقد خرج فعلاً من الخزينة وإرجاعه شأن أمين الخزينة (إلغاء السند من
 *    شاشة السندات بقواعد فصل المهام هناك). الرسالة للمستخدم توثّق ذلك.
 *
 * قرار Maker-Checker (موثَّق): سند بمبلغ ≥ getApprovalThreshold() يُسجَّل PENDING_APPROVAL
 * **بلا أثر مالي** حتى اعتماد مدير ثانٍ. سلفة ACTIVE تعني خصماً تلقائياً من الرواتب، وتفعيلها
 * على سندٍ لم يُصرَف نقده بعد يخصم راتباً عن نقدٍ لم يخرج (وقد يُرفَض السند لاحقاً بلا أثر على
 * السلفة — لا خطّاف لدينا في مسار الاعتماد ولا حالة «معلّقة» في المخطط). لذا **نرفض المنح
 * بمبلغ يبلغ العتبة برسالة صريحة** قبل إنشاء أي شيء — الطريق الأمين للمبالغ الكبيرة: سند صرف
 * من شاشة السندات (يمرّ بالاعتماد الثنائي) ثم خصم يدوي، أو تقسيم السلفة، أو رفع العتبة بقرار مالك.
 * ========================================================================== */
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import { advanceSettlements, branches, employeeAdvances, employees, idempotencyKeys, receipts, voucherCategories } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { money, round2, toDbMoney } from "../money";
import { requireDb, withTx, type Actor } from "../tx";
import { getApprovalThreshold } from "../voucher/thresholds";
import {
  createVoucherTx,
  employeeAdvanceReference,
  employeeAdvanceSourceHash,
  type SystemPaymentRequest,
} from "../voucher/create";

export * from "../payroll/advanceRepayment";

/** عَتبة السندات (اعتماد ثنائي) — تُعرَض للواجهة عبر بوّابة hr (بوّابة الخزينة لا تلزم هنا).
 *  لا عَتبة مُرفق: المُرفق اختياريّ دائماً (٣١/٧). */
export function advanceThresholds() {
  return { approval: getApprovalThreshold() };
}

/* ─────────────────────────── قراءة ─────────────────────────── */

export interface ListAdvancesFilters {
  employeeId?: number;
  branchId?: number;
  status?: "ACTIVE" | "SETTLED" | "CANCELLED";
}

export async function listAdvances(filters?: ListAdvancesFilters) {
  const db = requireDb();
  if (filters?.branchId != null && (!Number.isInteger(filters.branchId) || filters.branchId <= 0)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "نطاق الفرع مطلوب." });
  }
  const conds = [];
  if (filters?.employeeId) conds.push(eq(employeeAdvances.employeeId, filters.employeeId));
  if (filters?.branchId != null) conds.push(eq(employeeAdvances.branchId, filters.branchId));
  if (filters?.status) conds.push(eq(employeeAdvances.status, filters.status));
  const rows = await db
    .select({
      id: employeeAdvances.id,
      employeeId: employeeAdvances.employeeId,
      branchId: employeeAdvances.branchId,
      amount: employeeAdvances.amount,
      remaining: employeeAdvances.remaining,
      monthlyDeduction: employeeAdvances.monthlyDeduction,
      status: employeeAdvances.status,
      receiptId: employeeAdvances.receiptId,
      note: employeeAdvances.note,
      createdBy: employeeAdvances.createdBy,
      grantedAt: employeeAdvances.grantedAt,
      firstName: employees.firstName,
      fatherName: employees.fatherName,
      grandfatherName: employees.grandfatherName,
      lastName: employees.lastName,
      position: employees.position,
      employmentStatus: employees.employmentStatus,
      branchName: branches.name,
      voucherNumber: receipts.voucherNumber,
    })
    .from(employeeAdvances)
    .leftJoin(employees, eq(employeeAdvances.employeeId, employees.id))
    .leftJoin(branches, eq(employeeAdvances.branchId, branches.id))
    .leftJoin(receipts, eq(employeeAdvances.receiptId, receipts.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(employeeAdvances.id));
  return rows.map((r) => ({ ...r, employeeName: fullEmployeeName(r) }));
}

/** رصيد السلف المتبقّي على موظف = مجموع remaining لسلفه النشطة. */
export async function employeeBalance(employeeId: number, branchId?: number): Promise<{ employeeId: number; balance: string; activeCount: number }> {
  const db = requireDb();
  if (branchId != null && (!Number.isInteger(branchId) || branchId <= 0)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "نطاق الفرع مطلوب." });
  }
  const rows = await db
    .select({ remaining: employeeAdvances.remaining })
    .from(employeeAdvances)
    .where(and(
      eq(employeeAdvances.employeeId, employeeId),
      eq(employeeAdvances.status, "ACTIVE"),
      branchId != null ? eq(employeeAdvances.branchId, branchId) : undefined,
    ));
  let sum = new Decimal(0);
  for (const r of rows) sum = sum.plus(money(r.remaining));
  return { employeeId, balance: toDbMoney(round2(sum)), activeCount: rows.length };
}

/* ─────────────────────────── منح سلفة ─────────────────────────── */

export interface GrantAdvanceInput {
  employeeId: number;
  branchId: number;
  amount: string;
  monthlyDeduction?: string | null;
  note?: string | null;
  /** مُرفق سند الصرف (صورة data URL أو رابط) — اختياريّ دائماً (لا إلزام مُرفق في النظام). */
  attachmentUrl?: string | null;
  /** idempotency (تدقيق ١٧/٧): إعادة إرسال بنفس المفتاح ⇒ لا سند/صرف ثانٍ (منع الصرف النقدي المزدوج). */
  clientRequestId: string;
}

/** فئة السند الافتراضية للسلف: «رواتب» (OUT، من بذرة 0036). غيابها لا يمنع المنح (فئة اختيارية). */
async function payrollCategoryIdTx(tx: Tx): Promise<number | null> {
  const [cat] = await tx
    .select({ id: voucherCategories.id })
    .from(voucherCategories)
    .where(and(eq(voucherCategories.name, "رواتب"), eq(voucherCategories.isActive, true), eq(voucherCategories.direction, "OUT")))
    .limit(1);
  return cat ? Number(cat.id) : null;
}

/**
 * منح سلفة = إنشاء طلب سند صرف معلّق فقط. لا ينشأ صف employeeAdvances ولا يبدأ الخصم
 * قبل اعتماد مالكٍ ثانٍ للسند. الاعتماد يستدعي activateAdvanceForApprovedVoucherTx داخل
 * المعاملة نفسها التي تُخرج النقد، فيصبح (الصرف + السلفة ACTIVE) أثراً ذرياً واحداً.
 */
type EmployeeAdvanceRequest = Extract<
  SystemPaymentRequest,
  { kind: "EMPLOYEE_ADVANCE" }
>;

type EmployeeAdvanceReceipt = {
  id: number;
  branchId: number | null;
  direction: string;
  amount: string;
  paymentMethod: string;
  partyType?: string | null;
  referenceNumber?: string | null;
  createdBy: number | null;
};

/** Validate the server-only capability against the locked source row and receipt facts. */
export async function assertEmployeeAdvanceVoucherRequestTx(
  tx: Tx,
  receipt: EmployeeAdvanceReceipt,
  request: EmployeeAdvanceRequest,
  options?: { requireMaterialized?: boolean },
) {
  const expectedReference = employeeAdvanceReference(request);
  if (
    expectedReference == null ||
    request.sourceHash !== employeeAdvanceSourceHash(request) ||
    receipt.referenceNumber !== expectedReference ||
    receipt.direction !== "OUT" ||
    receipt.paymentMethod !== "CASH" ||
    receipt.partyType !== "OTHER" ||
    receipt.branchId == null ||
    Number(receipt.branchId) !== request.branchId ||
    !money(receipt.amount).eq(request.expectedAmount) ||
    receipt.createdBy == null
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "بيانات سلفة الموظف أو قابليتها النظامية لا تطابق السند — أوقف العملية وراجع سجل المصدر",
    });
  }

  const provenanceKey = `ADVANCE:${request.sourceClientRequestId}`;
  const provenanceRows = await tx
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.operation, "voucher.create"),
        eq(idempotencyKeys.clientRequestId, provenanceKey),
        eq(idempotencyKeys.refId, receipt.id),
      ),
    )
    .for("update")
    .limit(2);
  if (provenanceRows.length !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "مصدر إنشاء سلفة الموظف غير مثبت بمفتاح idempotency مرتبط بالسند — أوقف العملية وراجع التدقيق",
    });
  }

  const [emp] = await tx
    .select()
    .from(employees)
    .where(eq(employees.id, request.employeeId))
    .for("update")
    .limit(1);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "موظف طلب السلفة غير موجود" });
  if (!emp.isActive || emp.employmentStatus === "terminated") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن اعتماد سلفة لموظف معطّل أو منتهي الخدمة" });
  }
  if (emp.branchId != null && Number(emp.branchId) !== request.branchId) {
    throw new TRPCError({ code: "CONFLICT", message: "فرع موظف السلفة لا يطابق لقطة الطلب الموثقة" });
  }
  if (emp.userId != null && Number(emp.userId) === Number(receipt.createdBy)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا يجوز للموظف إنشاء طلب سلفة لنفسه" });
  }

  let materialized: typeof employeeAdvances.$inferSelect | null = null;
  if (options?.requireMaterialized) {
    [materialized] = await tx
      .select()
      .from(employeeAdvances)
      .where(eq(employeeAdvances.receiptId, receipt.id))
      .for("update")
      .limit(1);
    if (
      !materialized ||
      materialized.status !== "ACTIVE" ||
      Number(materialized.employeeId) !== request.employeeId ||
      Number(materialized.branchId) !== request.branchId ||
      !money(materialized.amount).eq(request.expectedAmount)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "سجل السلفة المادي لا يطابق السند الموثق" });
    }
  }
  return { employee: emp, materialized };
}

/**
 * سقف السلف غير المسدّدة يُحسم عند الاعتماد، لا عند إنشاء الطلب.
 *
 * قفل الموظف في المستدعي هو قفل التجميع الحاكم: كل تفعيل لسلفة الموظف نفسه يمرّ به،
 * لذلك لا يستطيع اعتمادان متزامنان قراءة الرصيد القديم معاً. نقفل صفوف ACTIVE أيضاً
 * كي يكون مجموع remaining لقطةً مستقرة أمام تسويات/إلغاءات الرواتب المتزامنة.
 * الطلبات المعلّقة ليست أصلاً ولا التزاماً على الموظف، فلا تدخل المجموع؛ لكنها تُعاد
 * محاكمتها هنا لحظة تحوّلها إلى ACTIVE وخروج النقد فعلياً.
 */
async function assertAdvanceOutstandingLimitTx(tx: Tx, employeeId: number, requested: Decimal): Promise<void> {
  const active = await tx
    .select({ id: employeeAdvances.id, remaining: employeeAdvances.remaining })
    .from(employeeAdvances)
    .where(and(eq(employeeAdvances.employeeId, employeeId), eq(employeeAdvances.status, "ACTIVE")))
    .orderBy(asc(employeeAdvances.id))
    .for("update");

  const outstanding = active.reduce((sum, row) => sum.plus(money(row.remaining)), new Decimal(0));
  const limit = money(getApprovalThreshold());
  if (outstanding.plus(requested).gt(limit)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `اعتماد السلفة يتجاوز سقف السلف غير المسدَّدة (${toDbMoney(limit)} د.ع) — الرصيد القائم ${toDbMoney(outstanding)} د.ع. سدِّد القائم أو ارفض الطلب.`,
    });
  }
}

export async function activateAdvanceForApprovedVoucherTx(
  tx: Tx,
  receipt: EmployeeAdvanceReceipt,
  request: EmployeeAdvanceRequest,
): Promise<number> {
  await assertEmployeeAdvanceVoucherRequestTx(tx, receipt, request);

  const [existing] = await tx.select({ id: employeeAdvances.id })
    .from(employeeAdvances).where(eq(employeeAdvances.receiptId, receipt.id)).limit(1);
  if (existing) return Number(existing.id);

  const amount = money(request.expectedAmount);
  const monthly = request.monthlyDeduction == null ? null : money(request.monthlyDeduction);
  await assertAdvanceOutstandingLimitTx(tx, request.employeeId, amount);
  const result = await tx.insert(employeeAdvances).values({
    employeeId: request.employeeId,
    branchId: request.branchId,
    amount: toDbMoney(amount),
    remaining: toDbMoney(amount),
    monthlyDeduction: monthly == null ? null : toDbMoney(monthly),
    status: "ACTIVE",
    receiptId: receipt.id,
    note: request.note,
    createdBy: receipt.createdBy!,
  });
  return extractInsertId(result);
}

export async function grantAdvance(input: GrantAdvanceInput, actor: Actor) {
  if (!input.clientRequestId?.trim()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف الطلب إلزامي لمنع صرف السلفة مرتين" });
  }
  const amount = money(input.amount);
  if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ السلفة يجب أن يكون موجباً" });
  const monthly = input.monthlyDeduction != null && String(input.monthlyDeduction).trim() !== "" ? money(input.monthlyDeduction) : null;
  if (monthly != null) {
    if (monthly.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الخصم الشهري يجب أن يكون موجباً (أو اتركه فارغاً = خصم أقصى الممكن)" });
    if (monthly.gt(amount)) throw new TRPCError({ code: "BAD_REQUEST", message: "الخصم الشهري لا يتجاوز مبلغ السلفة" });
  }

  return withTx(async (tx) => {
    const [emp] = await tx.select().from(employees).where(eq(employees.id, input.employeeId)).for("update").limit(1);
    if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
    if (!emp.isActive || emp.employmentStatus === "terminated") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُمنح سلفة لموظف معطَّل أو منتهي الخدمة" });
    }
    if (emp.userId != null && Number(emp.userId) === Number(actor.userId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "لا تطلب سلفةً لنفسك — فصل المهام يوجب أن ينشئها مستخدمٌ آخر" });
    }
    if (emp.branchId != null && Number(emp.branchId) !== Number(input.branchId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "فرع صرف السلفة يجب أن يطابق فرع الموظف" });
    }
    const empName = fullEmployeeName(emp);
    const source = {
      employeeId: input.employeeId,
      branchId: input.branchId,
      expectedAmount: toDbMoney(amount),
      monthlyDeduction: monthly == null ? null : toDbMoney(monthly),
      note: input.note?.trim() || null,
      sourceClientRequestId: input.clientRequestId.trim(),
    };
    const systemRequest: EmployeeAdvanceRequest = {
      kind: "EMPLOYEE_ADVANCE",
      ...source,
      sourceHash: employeeAdvanceSourceHash(source),
    };
    const referenceNumber = employeeAdvanceReference(systemRequest);
    if (!referenceNumber) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "تعذر اشتقاق مرجع سلفة الموظف" });
    }

    const voucher = await createVoucherTx(tx, {
      voucherType: "PAYMENT",
      branchId: input.branchId,
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      partyType: "OTHER",
      counterpartyName: empName,
      referenceNumber,
      description: `سلفة موظف — ${empName}${input.note?.trim() ? ` — ${input.note.trim()}` : ""}`,
      voucherCategoryId: await payrollCategoryIdTx(tx),
      // المُرفق اختياريّ (٣١/٧: أُلغيت عتبة إلزام المُرفق من النظام كله).
      attachmentUrl: input.attachmentUrl?.trim() || null,
      clientRequestId: `ADVANCE:${input.clientRequestId}`,
    }, actor, { systemRequest });
    const [storedReceipt] = await tx.select().from(receipts).where(eq(receipts.id, voucher.receiptId)).limit(1);
    if (
      storedReceipt?.referenceNumber !== referenceNumber ||
      storedReceipt.internalNote == null ||
      !storedReceipt.internalNote.includes(`\"sourceHash\":\"${systemRequest.sourceHash}\"`)
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "تعارض idempotency: معرّف الطلب مستعمل لسلفة ببيانات مختلفة" });
    }
    const [active] = await tx.select().from(employeeAdvances)
      .where(eq(employeeAdvances.receiptId, voucher.receiptId)).limit(1);
    if (active) return { ...active, employeeName: empName, voucherNumber: voucher.voucherNumber };
    return {
      id: null,
      employeeId: input.employeeId,
      branchId: input.branchId,
      amount: toDbMoney(amount),
      remaining: toDbMoney(amount),
      monthlyDeduction: monthly == null ? null : toDbMoney(monthly),
      status: "PENDING_APPROVAL" as const,
      receiptId: voucher.receiptId,
      note: systemRequest.note,
      createdBy: actor.userId,
      employeeName: empName,
      voucherNumber: voucher.voucherNumber,
      approvalStatus: voucher.approvalStatus,
    };
  });
}

/* ─────────────────────────── إلغاء سلفة ─────────────────────────── */

/**
 * إلغاء سلفة — فقط قبل أي خصم (remaining == amount) **وبعد عكس سند صرفها**.
 *
 * ⚠️ لماذا يُشترط عكس السند أولاً (ثغرة حرجة كانت مفتوحة): إلغاء السلفة يمحو التزام
 * السداد (لا تُخصم من الرواتب بعدها)، بينما النقد خرج فعلاً من الخزينة لحظة المنح.
 * وبما أن المنح تحت العتبة يُنشئ سنداً **معتمَداً فوراً** بفاعلٍ واحد، كان بوسع مستخدمٍ
 * واحد بصلاحية hr=FULL أن يمنح نفسه ٩٩٩٬٠٠٠ ثم يلغيها فيبقى النقد بلا دَينٍ ولا أثر.
 * كان التنبيه نصّياً فقط (voucherNotice) ولا شيء يفرضه.
 *
 * الآن: عكس السند يُنفَّذ من شاشة السندات (حيث فصل المهام مفروض)، ثم تُلغى السلفة.
 * الترتيب مقصود — النقد يعود أولاً، والالتزام يسقط بعده، فلا نافذة يسقط فيها الالتزام وحده.
 */
export async function cancelAdvance(input: { advanceId: number; reason?: string | null }, actor: Actor) {
  return withTx(async (tx) => {
    const [adv] = await tx.select().from(employeeAdvances).where(eq(employeeAdvances.id, input.advanceId)).for("update").limit(1);
    if (!adv) throw new TRPCError({ code: "NOT_FOUND", message: "السلفة غير موجودة" });
    if (adv.status !== "ACTIVE") throw new TRPCError({ code: "BAD_REQUEST", message: "تُلغى السلف النشطة فقط" });
    if (!money(adv.remaining).eq(money(adv.amount))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُلغى سلفة خُصم منها فعلاً — بقيّتها تُخصم من الرواتب القادمة حتى التسوية" });
    }
    if (adv.receiptId != null) {
      const [rc] = await tx
        .select({ status: receipts.status, voucherNumber: receipts.voucherNumber, approvalStatus: receipts.approvalStatus })
        .from(receipts)
        .where(eq(receipts.id, Number(adv.receiptId)))
        .for("update")
        .limit(1);
      // REVERSED = عُكس السند وعاد النقد. REJECTED = لم يُصرف أصلاً. ما عداهما ⇒ النقد بالخارج.
      const cashReturned = rc == null || rc.status === "REVERSED" || rc.approvalStatus === "REJECTED";
      if (!cashReturned) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `لا تُلغى السلفة وسند صرفها ما زال سارياً — النقد خرج من الخزينة، وإلغاء السلفة وحده يمحو التزام السداد. ألغِ السند ${rc.voucherNumber ?? ""} من شاشة السندات أولاً (يمرّ بفصل المهام) ثم أعد الإلغاء.`.trim(),
        });
      }
    }
    const reason = input.reason?.trim();
    const note = [adv.note, reason ? `إلغاء: ${reason}` : "أُلغيت"].filter(Boolean).join(" — ").slice(0, 255);
    await tx.update(employeeAdvances).set({ status: "CANCELLED", note }).where(eq(employeeAdvances.id, input.advanceId));
    void actor;
    return {
      id: input.advanceId,
      status: "CANCELLED" as const,
      receiptId: adv.receiptId != null ? Number(adv.receiptId) : null,
      voucherNotice: "أُلغيت السلفة بعد عكس سند صرفها — لا نقد خارج الخزينة بلا التزام.",
    };
  });
}

/* ─────────────────────────── اقتراح استقطاعات الشهر ─────────────────────────── */

export interface SuggestedDeduction {
  advanceId: number;
  suggested: Decimal;
}

/**
 * اقتراح استقطاع الشهر لكل موظف: من **أقدم** سلفة نشطة فقط (سلفة تلو الأخرى حتى تسويتها)،
 * suggested = min(monthlyDeduction ?? remaining، remaining). يُستدعى داخل معاملة توليد المسيّر.
 */
export async function suggestDeductionsTx(tx: Tx, employeeIds: number[]): Promise<Map<number, SuggestedDeduction>> {
  const out = new Map<number, SuggestedDeduction>();
  if (employeeIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(employeeAdvances)
    .where(and(inArray(employeeAdvances.employeeId, employeeIds), eq(employeeAdvances.status, "ACTIVE")))
    .orderBy(asc(employeeAdvances.id));
  for (const adv of rows) {
    const empId = Number(adv.employeeId);
    if (out.has(empId)) continue; // الأقدم أولاً — سلفة واحدة لكل شهر.
    const remaining = money(adv.remaining);
    if (remaining.lte(0)) continue;
    const monthly = adv.monthlyDeduction != null ? money(adv.monthlyDeduction) : null;
    const suggested = round2(Decimal.min(monthly ?? remaining, remaining));
    if (suggested.lte(0)) continue;
    out.set(empId, { advanceId: Number(adv.id), suggested });
  }
  return out;
}

/** نسخة عامة (خارج معاملة) — للاستعلام من الراوتر/الواجهة. */
export async function suggestDeductionsForPeriod(employeeIds: number[]): Promise<Record<number, { advanceId: number; suggested: string }>> {
  return withTx(async (tx) => {
    const map = await suggestDeductionsTx(tx, employeeIds);
    const out: Record<number, { advanceId: number; suggested: string }> = {};
    map.forEach((v, empId) => {
      out[empId] = { advanceId: v.advanceId, suggested: toDbMoney(v.suggested) };
    });
    return out;
  });
}

/* ─────────────────────────── تسوية عند صرف المسيّر ─────────────────────────── */

/**
 * تُستدعى من payRun داخل معاملة الدفع: لكل بند advanceDeduction > 0 تُنقص أرصدة سلف
 * الموظف النشطة **بالأقدم أولاً** (قفل .for("update"))؛ بلوغ الصفر ⇒ SETTLED.
 * إن عجزت السلف النشطة عن استيعاب المبلغ (أُلغيت سلفة بين التوليد والدفع) ⇒ CONFLICT
 * يُدحرج معاملة الدفع كلها — أعد المسيّر لمسودة وولّده من جديد ليتّسق الاستقطاع.
 */
export async function settleAdvancesOnPayTx(
  tx: Tx,
  items: { employeeId: number; amount: Decimal }[],
  runId: number,
): Promise<void> {
  for (const item of items) {
    let left = round2(item.amount);
    if (left.lte(0)) continue;
    const advs = await tx
      .select()
      .from(employeeAdvances)
      .where(and(eq(employeeAdvances.employeeId, item.employeeId), eq(employeeAdvances.status, "ACTIVE")))
      .orderBy(asc(employeeAdvances.id))
      .for("update");
    for (const adv of advs) {
      if (left.lte(0)) break;
      const remaining = money(adv.remaining);
      if (remaining.lte(0)) continue;
      const take = Decimal.min(remaining, left);
      const newRemaining = round2(remaining.minus(take));
      left = round2(left.minus(take));
      await tx
        .update(employeeAdvances)
        .set({ remaining: toDbMoney(newRemaining), status: newRemaining.lte(0) ? "SETTLED" : "ACTIVE" })
        .where(eq(employeeAdvances.id, Number(adv.id)));
      // تسجيل التسوية مربوطةً بالمسيّر (تدقيق ١٧/٧) ⇒ استعادةٌ دقيقة عند حذف المسيّر تمنع الخصم المضاعف.
      await tx.insert(advanceSettlements).values({
        runId,
        advanceId: Number(adv.id),
        employeeId: item.employeeId,
        amount: toDbMoney(take),
      });
    }
    if (left.gt(0)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "استقطاع سلفة في المسيّر يفوق أرصدة السلف النشطة للموظف (أُلغيت سلفة بعد التوليد؟) — أعد المسيّر لمسودة وولّده من جديد",
      });
    }
  }
}

/**
 * استعادة تسويات سلف مسيّرٍ عند **حذفه** (تدقيق ١٧/٧): تُعيد remaining لكل سلفة سُوّيت بهذا المسيّر
 * وتُعيدها ACTIVE، ثم تحذف سجلّات التسوية. لا تُستدعى عند **عكس** الدفع (إعادة الدفع لا تُعيد التسوية
 * عبر isFirstPay) — فقط عند الحذف النهائيّ، وإلا أعاد توليدُ مسيّرٍ جديد خصماً مضاعفاً على السلفة.
 */
export async function restoreAdvanceSettlementsTx(tx: Tx, runId: number): Promise<void> {
  const settlements = await tx.select().from(advanceSettlements).where(eq(advanceSettlements.runId, runId));
  for (const st of settlements) {
    const [adv] = await tx
      .select()
      .from(employeeAdvances)
      .where(eq(employeeAdvances.id, Number(st.advanceId)))
      .for("update")
      .limit(1);
    if (!adv) continue;
    // القيمة الأصلية amount سقفٌ (لا تتجاوزه الاستعادة). remaining يعود موجباً ⇒ ACTIVE (السلفة لا
    // تُلغى بعد أيّ خصم، فحالة CANCELLED غير واردة هنا).
    const restored = Decimal.min(round2(money(adv.remaining).plus(money(st.amount))), money(adv.amount));
    await tx
      .update(employeeAdvances)
      .set({ remaining: toDbMoney(restored), status: restored.gt(0) ? "ACTIVE" : adv.status })
      .where(eq(employeeAdvances.id, Number(adv.id)));
  }
  await tx.delete(advanceSettlements).where(eq(advanceSettlements.runId, runId));
}

