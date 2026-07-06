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
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { fullEmployeeName } from "@shared/hr";
import { branches, employeeAdvances, employees, receipts, voucherCategories } from "../../drizzle/schema";
import type { Tx } from "../db";
import { extractInsertId } from "../lib/insertId";
import { money, round2, toDbMoney } from "./money";
import { requireDb, withTx, type Actor } from "./tx";
import { cancelVoucher, createVoucher, getApprovalThreshold, getAttachmentThreshold } from "./voucherService";

/** عتبتا السندات (اعتماد ثنائي + إلزام مُرفق) — تُعرَض للواجهة عبر بوّابة hr (بوّابة الخزينة لا تلزم هنا). */
export function advanceThresholds() {
  return { approval: getApprovalThreshold(), attachment: getAttachmentThreshold() };
}

/* ─────────────────────────── قراءة ─────────────────────────── */

export interface ListAdvancesFilters {
  employeeId?: number;
  branchId?: number;
  status?: "ACTIVE" | "SETTLED" | "CANCELLED";
}

export async function listAdvances(filters?: ListAdvancesFilters) {
  const db = requireDb();
  const conds = [];
  if (filters?.employeeId) conds.push(eq(employeeAdvances.employeeId, filters.employeeId));
  if (filters?.branchId) conds.push(eq(employeeAdvances.branchId, filters.branchId));
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
export async function employeeBalance(employeeId: number): Promise<{ employeeId: number; balance: string; activeCount: number }> {
  const db = requireDb();
  const rows = await db
    .select({ remaining: employeeAdvances.remaining })
    .from(employeeAdvances)
    .where(and(eq(employeeAdvances.employeeId, employeeId), eq(employeeAdvances.status, "ACTIVE")));
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
  /** مُرفق سند الصرف (صورة data URL أو رابط) — إلزامي خادمياً للمبالغ ≥ عتبة المُرفق (vouchers-pro). */
  attachmentUrl?: string | null;
}

/** فئة السند الافتراضية للسلف: «رواتب» (OUT، من بذرة 0036). غيابها لا يمنع المنح (فئة اختيارية). */
async function payrollCategoryId(): Promise<number | null> {
  const db = requireDb();
  const [cat] = await db
    .select({ id: voucherCategories.id })
    .from(voucherCategories)
    .where(and(eq(voucherCategories.name, "رواتب"), eq(voucherCategories.isActive, true), eq(voucherCategories.direction, "OUT")))
    .limit(1);
  return cat ? Number(cat.id) : null;
}

/**
 * منح سلفة: سند صرف حقيقي عبر createVoucher (خزينة/درج حسب دور المانح — نفس سياسة السندات)
 * ثم إدراج السلفة remaining = amount مربوطةً بالسند.
 *
 * ملاحظة ذرّية (موثَّقة): createVoucher يفتح معاملته الذرّية الخاصة (withTx داخلية) —
 * تداخله في معاملة خارجية يعني اتصالاً ثانياً غير ذرّي معها أصلاً. لذا التسلسل: سند أولاً
 * (ذرّي بكامل أثره المالي) ثم إدراج السلفة في معاملة ثانية؛ وعند فشل الإدراج (احتمال نظري —
 * إدراج بسيط بمراجع تحقّقنا منها) نُعوّض بإلغاء السند آلياً، وإن تعذّر الإلغاء (فصل مهام) نُسمّي
 * رقم السند في الخطأ ليُلغى يدوياً — لا سلفة بلا سند ولا صرف صامت بلا سلفة.
 */
export async function grantAdvance(input: GrantAdvanceInput, actor: Actor) {
  const amount = money(input.amount);
  if (amount.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "مبلغ السلفة يجب أن يكون موجباً" });
  const monthly = input.monthlyDeduction != null && String(input.monthlyDeduction).trim() !== "" ? money(input.monthlyDeduction) : null;
  if (monthly != null) {
    if (monthly.lte(0)) throw new TRPCError({ code: "BAD_REQUEST", message: "الخصم الشهري يجب أن يكون موجباً (أو اتركه فارغاً = خصم أقصى الممكن)" });
    if (monthly.gt(amount)) throw new TRPCError({ code: "BAD_REQUEST", message: "الخصم الشهري لا يتجاوز مبلغ السلفة" });
  }

  // قرار Maker-Checker (انظر رأس الملف): مبلغ يبلغ عتبة الاعتماد الثنائي يُرفض هنا صراحةً.
  const threshold = getApprovalThreshold();
  if (amount.toNumber() >= threshold) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `مبلغ السلفة يبلغ عتبة الاعتماد الثنائي للسندات (${threshold.toLocaleString("ar-IQ-u-nu-latn")} د.ع) — للمبالغ الكبيرة أصدر سند صرف من شاشة السندات (يمرّ بالاعتماد) أو قسّم السلفة.`,
    });
  }

  const db = requireDb();
  const [emp] = await db.select().from(employees).where(eq(employees.id, input.employeeId)).limit(1);
  if (!emp) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
  if (!emp.isActive || emp.employmentStatus === "terminated") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُمنح سلفة لموظف معطَّل أو منتهي الخدمة" });
  }
  const empName = fullEmployeeName(emp);

  // ١) سند الصرف الحقيقي (ذرّي بكامل أثره: receipt + قيد PAYMENT_OUT + دلو الخزينة).
  const voucher = await createVoucher(
    {
      voucherType: "PAYMENT",
      branchId: input.branchId,
      amount: toDbMoney(amount),
      paymentMethod: "CASH",
      partyType: "OTHER",
      counterpartyName: empName,
      description: `سلفة موظف — ${empName}${input.note?.trim() ? ` — ${input.note.trim()}` : ""}`,
      voucherCategoryId: await payrollCategoryId(),
      // عتبة المُرفق (vouchers-pro) تسري على سند السلفة كأي سند صرف — createVoucher يفرضها.
      attachmentUrl: input.attachmentUrl?.trim() || null,
    },
    actor,
  );
  // حارس دفاعي: العتبة فُحصت أعلاه فلا يصل سند معلَّق إلى هنا — إن وصل (تغيّرت العتبة بين
  // الفحص والإنشاء) نعوّض بالإلغاء ونرفض: سلفة نشطة على سندٍ بلا أثر مالي ممنوعة.
  if (voucher.approvalStatus !== "APPROVED") {
    await cancelVoucher(voucher.receiptId, actor).catch(() => undefined);
    throw new TRPCError({ code: "BAD_REQUEST", message: "سند السلفة يتطلّب اعتماداً ثنائياً — خفّض المبلغ تحت العتبة" });
  }

  // ٢) صفّ السلفة مربوطاً بالسند.
  try {
    return await withTx(async (tx) => {
      const res = await tx.insert(employeeAdvances).values({
        employeeId: input.employeeId,
        branchId: input.branchId,
        amount: toDbMoney(amount),
        remaining: toDbMoney(amount),
        monthlyDeduction: monthly != null ? toDbMoney(monthly) : null,
        status: "ACTIVE",
        receiptId: voucher.receiptId,
        note: input.note?.trim() || null,
        createdBy: actor.userId,
      });
      const advanceId = extractInsertId(res);
      const [row] = await tx.select().from(employeeAdvances).where(eq(employeeAdvances.id, advanceId)).limit(1);
      return { ...row!, employeeName: empName, voucherNumber: voucher.voucherNumber };
    });
  } catch (err) {
    // تعويض: أُنشئ السند ولم تُسجَّل السلفة ⇒ نحاول إلغاء السند؛ وإن تعذّر نسمّيه للمستخدم.
    const reversed = await cancelVoucher(voucher.receiptId, actor).then(() => true).catch(() => false);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: reversed
        ? "فشل تسجيل السلفة — أُلغي سند الصرف آلياً، لم يُصرف شيء. أعد المحاولة."
        : `فشل تسجيل السلفة بعد إنشاء سند الصرف ${voucher.voucherNumber} — ألغِ السند يدوياً من شاشة السندات ثم أعد المحاولة.`,
      cause: err,
    });
  }
}

/* ─────────────────────────── إلغاء سلفة ─────────────────────────── */

/**
 * إلغاء سلفة — فقط قبل أي خصم (remaining == amount). لا يُعكَس سند الصرف الأصلي آلياً:
 * النقد خرج فعلاً، وإرجاعه للخزينة قرار خزينة يُنفَّذ بإلغاء السند من شاشة السندات
 * (بقواعد فصل المهام هناك). الرسالة المعادة تنبّه المستخدم لذلك.
 */
export async function cancelAdvance(input: { advanceId: number; reason?: string | null }, actor: Actor) {
  return withTx(async (tx) => {
    const [adv] = await tx.select().from(employeeAdvances).where(eq(employeeAdvances.id, input.advanceId)).for("update").limit(1);
    if (!adv) throw new TRPCError({ code: "NOT_FOUND", message: "السلفة غير موجودة" });
    if (adv.status !== "ACTIVE") throw new TRPCError({ code: "BAD_REQUEST", message: "تُلغى السلف النشطة فقط" });
    if (!money(adv.remaining).eq(money(adv.amount))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا تُلغى سلفة خُصم منها فعلاً — بقيّتها تُخصم من الرواتب القادمة حتى التسوية" });
    }
    const reason = input.reason?.trim();
    const note = [adv.note, reason ? `إلغاء: ${reason}` : "أُلغيت"].filter(Boolean).join(" — ").slice(0, 255);
    await tx.update(employeeAdvances).set({ status: "CANCELLED", note }).where(eq(employeeAdvances.id, input.advanceId));
    void actor;
    return {
      id: input.advanceId,
      status: "CANCELLED" as const,
      receiptId: adv.receiptId != null ? Number(adv.receiptId) : null,
      // توثيق للمستخدم: السند الأصلي شأن الخزينة — لا يُعكَس آلياً.
      voucherNotice: "أُلغيت السلفة. سند الصرف الأصلي لم يُعكَس آلياً — إن أُريد إرجاع النقد للخزينة ألغِ السند من شاشة السندات.",
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
export async function settleAdvancesOnPayTx(tx: Tx, items: { employeeId: number; amount: Decimal }[]): Promise<void> {
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
    }
    if (left.gt(0)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "استقطاع سلفة في المسيّر يفوق أرصدة السلف النشطة للموظف (أُلغيت سلفة بعد التوليد؟) — أعد المسيّر لمسودة وولّده من جديد",
      });
    }
  }
}
