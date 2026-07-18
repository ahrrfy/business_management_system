// بند 12أ (٧/٧): خدمة الأقساط والشيكات الآجلة.
//
// الدلالة المالية (موثَّقة في تعليق جدول installmentPlans): الخطة **جدولة تحصيل** فوق ذمّة
// العميل القائمة — لا قيد محاسبي عند الإنشاء. سداد كل قسط يمرّ عبر سند قبض حقيقي
// (createVoucher) فيتحرّك AR والدفتر بالمسار الموحَّد القائم (postEntry + adjustCustomerBalance).
//
// Maker-Checker: createVoucher قد يُعيد PENDING_APPROVAL للمبالغ ≥ عتبة الاعتماد — عندها
// **القسط يبقى PENDING** مع ملاحظة تُسمّي رقم السند المعلَّق (لا أثر مالي حتى الاعتماد)،
// وإعادة استدعاء payLine بعد اعتماد السند تُكمل الوسم PAID عبر **نفس مفتاح idempotency**
// (`instpay-<lineId>`) بلا سند مزدوج — راجع تعليق payLine.
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, like, lte, or, sql } from "drizzle-orm";
import {
  customers,
  installmentLines,
  installmentPlans,
  invoices,
  receipts,
  voucherCategories,
  branches,
} from "../../drizzle/schema";
import { extractInsertId } from "../lib/insertId";
import { adjustCustomerBalance, computeInvoiceStatus, postEntry } from "./ledgerService";
import { money, sumMoney, toDbMoney, toDateStr } from "./money";
import { requireDb, withTx, type Actor } from "./tx";
import { createVoucher } from "./voucherService";

/* ============================ عقود المدخلات/المخرجات ============================ */

export type InstallmentKind = "CASH" | "CHECK";
export type PlanStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";
export type LineStatus = "PENDING" | "PAID" | "BOUNCED" | "CANCELLED";

export interface InstallmentLineInput {
  /** تاريخ الاستحقاق YYYY-MM-DD. */
  dueDate: string;
  /** مبلغ القسط (موجب، منزلتان). */
  amount: string;
  kind: InstallmentKind;
  /** إلزامي حين kind=CHECK. */
  checkNumber?: string | null;
  bankName?: string | null;
}

export interface CreatePlanInput {
  customerId: number;
  /** ربط اختياري بفاتورة بيع — يجب أن تخصّ نفس العميل وغير ملغاة. */
  invoiceId?: number | null;
  branchId: number;
  totalAmount: string;
  downPayment?: string | null;
  lines: InstallmentLineInput[];
  notes?: string | null;
}

export interface PayLineInput {
  lineId: number;
  /** الافتراضي: CHECK لقسط شيك، CASH لغيره. */
  paymentMethod?: "CASH" | "CARD" | "CHECK" | "TRANSFER" | "WALLET" | null;
  note?: string | null;
  /** مُرفق السند (createVoucher يُلزِمه للمبالغ ≥ عتبة المُرفق). */
  attachmentUrl?: string | null;
}

export interface PayLineResult {
  /** PAID = سُدِّد وأثّر مالياً؛ PENDING_APPROVAL = السند بانتظار اعتماد مدير ثانٍ والقسط باقٍ PENDING. */
  status: "PAID" | "PENDING_APPROVAL";
  receiptId: number;
  voucherNumber: string;
  /** true إن اكتملت كل أقساط الخطة بعد هذا السداد. */
  planCompleted: boolean;
}

/** قيد عزل الفرع (يمرّره الراوتر): null = بلا قيد (admin/مدير عابر)، رقم = الخطة يجب أن تخصّ هذا الفرع. */
export type BranchRestriction = number | null;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertPlanBranch(planBranchId: number, restrictToBranchId: BranchRestriction) {
  if (restrictToBranchId != null && Number(planBranchId) !== Number(restrictToBranchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "هذه الخطة تخصّ فرعاً آخر" });
  }
}

/* ============================ إنشاء خطة ============================ */

export async function createPlan(input: CreatePlanInput, actor: Actor): Promise<{ planId: number }> {
  const total = money(input.totalAmount);
  if (total.lte(0)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "إجمالي الخطة يجب أن يكون موجباً" });
  }
  const down = money(input.downPayment ?? "0");
  if (down.isNegative()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الدفعة الأولى لا يمكن أن تكون سالبة" });
  }
  if (!input.lines || input.lines.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الخطة تحتاج قسطاً واحداً على الأقل" });
  }

  // تحقّقات الأسطر: مبالغ موجبة + تواريخ صالحة متصاعدة + شيك برقم شيك.
  for (let i = 0; i < input.lines.length; i++) {
    const ln = input.lines[i];
    if (money(ln.amount).lte(0)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `مبلغ القسط رقم ${i + 1} يجب أن يكون موجباً` });
    }
    if (!YMD_RE.test(ln.dueDate)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `تاريخ القسط رقم ${i + 1} غير صالح (YYYY-MM-DD)` });
    }
    if (i > 0 && ln.dueDate < input.lines[i - 1].dueDate) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `تواريخ الأقساط يجب أن تكون متصاعدة — القسط رقم ${i + 1} (${ln.dueDate}) أسبق من الذي قبله (${input.lines[i - 1].dueDate})`,
      });
    }
    if (ln.kind === "CHECK" && !ln.checkNumber?.trim()) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `القسط رقم ${i + 1} شيك — رقم الشيك إلزامي` });
    }
  }

  // Σ(الأقساط) + الدفعة الأولى = الإجمالي، بدقّة decimal (لا floats).
  const linesSum = sumMoney(input.lines.map((l) => l.amount));
  const scheduled = linesSum.plus(down);
  if (!scheduled.eq(total)) {
    const diff = total.minus(scheduled);
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `مجموع الأقساط (${toDbMoney(linesSum)}) + الدفعة الأولى (${toDbMoney(down)}) لا يطابق إجمالي الخطة (${toDbMoney(total)}) — الفرق ${toDbMoney(diff)} د.ع`,
    });
  }

  return withTx(async (tx) => {
    const cust = (await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
    if (!cust) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    if (!cust.isActive) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن إنشاء خطة أقساط لعميل مُعطَّل" });
    }

    const br = (await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, input.branchId)).limit(1))[0];
    if (!br) throw new TRPCError({ code: "NOT_FOUND", message: "الفرع غير موجود" });

    if (input.invoiceId != null) {
      const inv = (await tx.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة المرتبطة غير موجودة" });
      if (Number(inv.customerId) !== Number(input.customerId)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة المرتبطة لا تخصّ هذا العميل" });
      }
      if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن الربط بفاتورة ملغاة أو مرتجعة" });
      }
    }

    // لا قيد محاسبي هنا عمداً — الخطة جدولة تحصيل فوق الذمّة القائمة (راجع رأس الملف).
    const planRes = await tx.insert(installmentPlans).values({
      customerId: input.customerId,
      invoiceId: input.invoiceId ?? null,
      branchId: input.branchId,
      totalAmount: toDbMoney(total),
      downPayment: toDbMoney(down),
      status: "ACTIVE",
      notes: input.notes?.trim() || null,
      createdBy: actor.userId,
    });
    const planId = extractInsertId(planRes);

    await tx.insert(installmentLines).values(
      input.lines.map((ln, i) => ({
        planId,
        seq: i + 1,
        dueDate: ln.dueDate,
        amount: toDbMoney(ln.amount),
        kind: ln.kind,
        checkNumber: ln.kind === "CHECK" ? (ln.checkNumber?.trim() ?? null) : (ln.checkNumber?.trim() || null),
        bankName: ln.bankName?.trim() || null,
        status: "PENDING" as const,
      })),
    );

    return { planId };
  });
}

/* ============================ سداد قسط ============================ */

/**
 * سداد قسط عبر **سند قبض حقيقي** (createVoucher) — الذمّة والدفتر يتحركان بالمسار الموحَّد.
 *
 * الذرّية عبر حدَّي معاملتين (createVoucher يفتح معاملته الخاصة داخلياً — لا يمكن تضمينه في
 * معاملتنا): نعتمد **idempotency حتمياً** بمفتاح `instpay-<lineId>` — كل قسط يُسدَّد مرّة
 * واحدة كحدّ أقصى في عمره، فلو انهار وسم القسط بعد إنشاء السند، إعادة المحاولة تُعيد نفس
 * السند (بلا قبض مزدوج) وتُكمل الوسم — تعافٍ ذاتي.
 *
 * Maker-Checker: إن أعاد createVoucher السند PENDING_APPROVAL (مبلغ ≥ العتبة) فلا أثر مالي
 * بعد ⇒ القسط يبقى PENDING مع ملاحظة تُسمّي السند المعلَّق. بعد اعتماد السند (شاشة السندات)
 * يعيد المستخدم «سداد» فيُعيد idempotency نفس السند بحالته الجديدة APPROVED ⇒ يُوسم PAID.
 */
export async function payLine(
  input: PayLineInput,
  actor: Actor,
  restrictToBranchId: BranchRestriction = null,
): Promise<PayLineResult> {
  const db = requireDb();

  const row = (
    await db
      .select({ line: installmentLines, plan: installmentPlans })
      .from(installmentLines)
      .innerJoin(installmentPlans, eq(installmentLines.planId, installmentPlans.id))
      .where(eq(installmentLines.id, input.lineId))
      .limit(1)
  )[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "القسط غير موجود" });
  const { line, plan } = row;
  assertPlanBranch(Number(plan.branchId), restrictToBranchId);

  if (plan.status !== "ACTIVE") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الخطة غير نشطة — لا يمكن سداد أقساطها" });
  }
  if (line.status !== "PENDING" && line.status !== "BOUNCED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: line.status === "PAID" ? "هذا القسط مسدَّد بالفعل" : "هذا القسط ملغى — لا يمكن سداده",
    });
  }

  const method = input.paymentMethod ?? (line.kind === "CHECK" ? "CHECK" : "CASH");

  // ربط سند القسط بفاتورة الخطة (يظهر في سجلّ دفعات الفاتورة) — فقط إن كانت ما تزال صالحة،
  // كي لا يُحجَب التحصيل لو أُلغيت الفاتورة بعد إنشاء الخطة (createVoucher يرفض الربط بملغاة).
  let voucherInvoiceId: number | null = null;
  if (plan.invoiceId != null) {
    const inv = (await db.select({ status: invoices.status, customerId: invoices.customerId }).from(invoices).where(eq(invoices.id, Number(plan.invoiceId))).limit(1))[0];
    if (inv && inv.status !== "CANCELLED" && inv.status !== "RETURNED" && Number(inv.customerId) === Number(plan.customerId)) {
      voucherInvoiceId = Number(plan.invoiceId);
    }
  }

  // فئة سند مناسبة (best-effort): أول فئة قبض نشطة يذكر اسمها الأقساط/التحصيل — وإلّا بلا فئة
  // (الفئات بيانات إدارية غير مبذورة إلزامياً؛ الوصف يحمل الدلالة كاملة).
  const cat = (
    await db
      .select({ id: voucherCategories.id })
      .from(voucherCategories)
      .where(
        and(
          eq(voucherCategories.isActive, true),
          inArray(voucherCategories.direction, ["IN", "BOTH"]),
          or(like(voucherCategories.name, "%قسط%"), like(voucherCategories.name, "%أقساط%")),
        ),
      )
      .limit(1)
  )[0];

  const checkInfo =
    line.kind === "CHECK"
      ? ` (شيك رقم ${line.checkNumber ?? "—"}${line.bankName ? ` — ${line.bankName}` : ""})`
      : "";
  const description = `تحصيل القسط رقم ${line.seq} من خطة الأقساط #${plan.id}${checkInfo}`;

  const voucher = await createVoucher(
    {
      voucherType: "RECEIPT",
      branchId: Number(plan.branchId),
      amount: toDbMoney(line.amount),
      paymentMethod: method,
      partyType: "CUSTOMER",
      partyId: Number(plan.customerId),
      description,
      checkNumber: method === "CHECK" ? (line.checkNumber ?? undefined) : undefined,
      voucherCategoryId: cat?.id != null ? Number(cat.id) : null,
      invoiceId: voucherInvoiceId,
      attachmentUrl: input.attachmentUrl ?? null,
      internalNote: input.note?.trim() || null,
      clientRequestId: `instpay-${Number(line.id)}`,
    },
    actor,
  );

  if (voucher.approvalStatus === "PENDING_APPROVAL") {
    // لا أثر مالي بعد ⇒ القسط يبقى PENDING؛ نوثّق السند المعلَّق في ملاحظة القسط.
    await db
      .update(installmentLines)
      .set({ note: `سند قبض ${voucher.voucherNumber} بانتظار اعتماد مدير ثانٍ (Maker-Checker)`.slice(0, 255) })
      .where(eq(installmentLines.id, Number(line.id)));
    return { status: "PENDING_APPROVAL", receiptId: voucher.receiptId, voucherNumber: voucher.voucherNumber, planCompleted: false };
  }
  // #installments-3 (تدقيق التثبيت): حارس أمان — لا نُوسم القسط PAID إلا بسند APPROVED فعلاً.
  // idempotency الجديد يتجاوز الـreplay على المرفوض (voucher/create.ts) لكن نُبقي هذا الحارس دفاعاً
  // متعدّد الطبقات لكل مسار محتمل يُنتج سنداً بحالة غير APPROVED (لا أثر مالي).
  if (voucher.approvalStatus !== "APPROVED") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `السند ${voucher.voucherNumber} غير معتمد (${voucher.approvalStatus}) — لا يمكن وسم القسط مدفوعاً`,
    });
  }

  // السند مُعتمَد ونافذ مالياً ⇒ وسم القسط PAID + فحص اكتمال الخطة، ذرّياً تحت قفل الصفّ.
  return withTx(async (tx) => {
    const locked = (
      await tx.select().from(installmentLines).where(eq(installmentLines.id, Number(line.id))).for("update").limit(1)
    )[0];
    if (!locked) throw new TRPCError({ code: "NOT_FOUND", message: "القسط غير موجود" });
    if (locked.status === "PAID") {
      // سباق/إعادة محاولة: سُدِّد بالفعل — بنفس السند (idempotency) ⇒ نجاح صامت؛ بغيره ⇒ تعارض.
      if (locked.receiptId != null && Number(locked.receiptId) === Number(voucher.receiptId)) {
        return { status: "PAID" as const, receiptId: voucher.receiptId, voucherNumber: voucher.voucherNumber, planCompleted: false };
      }
      throw new TRPCError({ code: "CONFLICT", message: "القسط سُدِّد بسند آخر بالتوازي — حدّث الشاشة" });
    }
    if (locked.status === "CANCELLED") {
      throw new TRPCError({ code: "CONFLICT", message: "أُلغي القسط أثناء السداد — راجع السند المُنشأ" });
    }

    await tx
      .update(installmentLines)
      .set({
        status: "PAID",
        receiptId: voucher.receiptId,
        paidAt: new Date(),
        note: input.note?.trim() ? input.note.trim().slice(0, 255) : locked.note,
      })
      .where(eq(installmentLines.id, Number(line.id)));

    // اكتمال الخطة: لا قسط PENDING/BOUNCED متبقٍّ ⇒ COMPLETED.
    const remaining = (
      await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(installmentLines)
        .where(
          and(
            eq(installmentLines.planId, Number(plan.id)),
            inArray(installmentLines.status, ["PENDING", "BOUNCED"]),
          ),
        )
    )[0];
    const planCompleted = Number(remaining?.n ?? 0) === 0;
    if (planCompleted) {
      await tx.update(installmentPlans).set({ status: "COMPLETED" }).where(eq(installmentPlans.id, Number(plan.id)));
    }

    return { status: "PAID" as const, receiptId: voucher.receiptId, voucherNumber: voucher.voucherNumber, planCompleted };
  });
}

/* ============================ ارتجاع شيك ============================ */

/**
 * ارتجاع شيك: قسط CHECK ⇒ BOUNCED.
 * - PENDING (الشيك لم يُحصَّل أصلاً) ⇒ تغيير حالة فقط، لا حركة مالية.
 * - PAID  (#installments-4 — تدقيق التثبيت): كان يُحجَب مطلقاً ⇒ الشيك يرتدّ في البنك بعد وسم القسط
 *   مدفوعاً فيبقى العميل «مدفوع» ورصيده منقوصاً بلا نقد فعلي (خسارة تتبُّع). نُنفّذ عكساً محاسبيّاً:
 *   receipt الأصل ⇒ REVERSED؛ قيد PAYMENT_OUT معاكس بمبلغ موجب؛ استعادة رصيد العميل (+amount).
 *   ذرّي داخل tx واحد؛ إن كان القسط مرتبطاً بفاتورة (voucher.invoiceId) نُعكِّس أثره على AR فيها أيضاً.
 */
export async function bounceCheck(
  input: { lineId: number; note?: string | null },
  actor: Actor,
  restrictToBranchId: BranchRestriction = null,
): Promise<{ lineId: number; reversed: boolean }> {
  return withTx(async (tx) => {
    const row = (
      await tx
        .select({ line: installmentLines, plan: installmentPlans })
        .from(installmentLines)
        .innerJoin(installmentPlans, eq(installmentLines.planId, installmentPlans.id))
        .where(eq(installmentLines.id, input.lineId))
        .for("update")
        .limit(1)
    )[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "القسط غير موجود" });
    assertPlanBranch(Number(row.plan.branchId), restrictToBranchId);
    if (row.line.kind !== "CHECK") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الارتجاع للشيكات فقط — هذا القسط نقدي" });
    }
    if (row.line.status !== "PENDING" && row.line.status !== "PAID") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الارتجاع متاح لشيك معلَّق أو محصَّل فقط" });
    }

    let reversed = false;
    if (row.line.status === "PAID" && row.line.receiptId != null) {
      const [rec] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, Number(row.line.receiptId)))
        .for("update")
        .limit(1);
      if (rec && rec.status === "COMPLETED") {
        const amount = money(rec.amount);
        const branchId = rec.branchId != null ? Number(rec.branchId) : Number(row.plan.branchId);
        // AR-BOUNCE (تدقيق ١٧/٧): كان يُعلَّم الإيصال الأصل REVERSED ⇒ إبطال إيصال وردية سابقة
        // (غالباً مغلقة) يغيّر مجاميع Z-report/الدرج بأثر رجعي، والقيد المعاكس بلا إيصال OUT فعليّ.
        // بدلاً منه: نُبقي الأصل (حدثٌ وقع فعلاً) ونُصدر إيصال عكسٍ **أماميّ** مكتمل — شيفت-محايد
        // (TREASURY، لا درج): ارتداد الشيك حدثٌ خزينيّ/ذمميّ لا سحبَ نقدٍ من درج الوردية الجارية،
        // فلا يشوّه أيّ Z-report ويسمح بارتداد شيكٍ حُصِّل في وردية مغلقة (الحالة الأشيع).
        const compRes = await tx.insert(receipts).values({
          invoiceId: rec.invoiceId ?? null,
          branchId,
          shiftId: null,
          cashBucket: "TREASURY",
          direction: "OUT",
          amount: toDbMoney(amount),
          paymentMethod: rec.paymentMethod,
          status: "COMPLETED",
          referenceNumber: `BOUNCE-CHK-${input.lineId}`,
          partyType: "CUSTOMER",
          partyId: Number(row.plan.customerId),
          description: `ارتداد شيك — القسط #${row.line.seq} من خطة #${row.plan.id}`,
          createdBy: actor.userId,
          approvalStatus: "APPROVED",
        });
        const compReceiptId = extractInsertId(compRes);
        await postEntry(tx, {
          entryType: "PAYMENT_OUT",
          branchId,
          receiptId: compReceiptId,
          customerId: Number(row.plan.customerId),
          amount,
          revenue: money(0),
          notes: `ارتداد شيك — القسط #${row.line.seq} من خطة #${row.plan.id}`,
        });
        // استعادة AR: التحصيل خفّض currentBalance بمقدار amount ⇒ نعيدها بإضافة +amount.
        await adjustCustomerBalance(tx, Number(row.plan.customerId), amount);
        reversed = true;
      }
      // إن كان القسط مرتبطاً بفاتورة، نُعكِّس paidAmount عليها + نحسب الحالة الصحيحة عبر
      // computeInvoiceStatus (كان يُسمَّر PARTIALLY_PAID ⇒ فاتورة عاد سدادها للصفر تبقى «مدفوعة جزئياً»).
      if (rec && row.plan.invoiceId != null) {
        const [inv] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, Number(row.plan.invoiceId)))
          .for("update")
          .limit(1);
        if (inv) {
          const newPaid = money(inv.paidAmount).minus(money(rec.amount));
          const paidClamped = newPaid.lt(0) ? money(0) : newPaid;
          const status = computeInvoiceStatus(inv.total, paidClamped.toFixed(2), inv.returnedTotal ?? "0");
          await tx
            .update(invoices)
            .set({ paidAmount: toDbMoney(paidClamped), status })
            .where(eq(invoices.id, Number(inv.id)));
        }
      }
    }

    await tx
      .update(installmentLines)
      .set({
        status: "BOUNCED",
        receiptId: null,
        paidAt: null,
        note: input.note?.trim() ? input.note.trim().slice(0, 255) : row.line.note,
      })
      .where(eq(installmentLines.id, input.lineId));
    // خطة مكتملة سابقاً؟ نُعيدها لـACTIVE لأن هناك قسطاً مرتدّاً يحتاج تحصيلاً جديداً.
    if (row.plan.status === "COMPLETED") {
      await tx.update(installmentPlans).set({ status: "ACTIVE" }).where(eq(installmentPlans.id, Number(row.plan.id)));
    }
    return { lineId: input.lineId, reversed };
  });
}

/* ============================ إلغاء خطة ============================ */

/** إلغاء خطة بلا أي قسط مسدَّد: الخطة CANCELLED وأقساطها المعلَّقة/المرتجعة CANCELLED. */
export async function cancelPlan(
  input: { planId: number; reason?: string | null },
  _actor: Actor,
  restrictToBranchId: BranchRestriction = null,
): Promise<{ planId: number }> {
  return withTx(async (tx) => {
    const plan = (
      await tx.select().from(installmentPlans).where(eq(installmentPlans.id, input.planId)).for("update").limit(1)
    )[0];
    if (!plan) throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة" });
    assertPlanBranch(Number(plan.branchId), restrictToBranchId);
    if (plan.status !== "ACTIVE") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الخطة ليست نشطة — لا يمكن إلغاؤها" });
    }
    const paid = (
      await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(installmentLines)
        .where(and(eq(installmentLines.planId, input.planId), eq(installmentLines.status, "PAID")))
    )[0];
    if (Number(paid?.n ?? 0) > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن إلغاء خطة سُدِّد منها قسط — ألغِ السندات أولاً من شاشة السندات إن لزم",
      });
    }
    const reason = input.reason?.trim();
    await tx
      .update(installmentPlans)
      .set({
        status: "CANCELLED",
        notes: reason ? `${plan.notes ? `${plan.notes}\n` : ""}أُلغيت: ${reason}` : plan.notes,
      })
      .where(eq(installmentPlans.id, input.planId));
    await tx
      .update(installmentLines)
      .set({ status: "CANCELLED" })
      .where(and(eq(installmentLines.planId, input.planId), inArray(installmentLines.status, ["PENDING", "BOUNCED"])));
    return { planId: input.planId };
  });
}

/* ============================ قوائم واستعلامات ============================ */

export interface ListPlansFilter {
  branchId?: number | null;
  customerId?: number | null;
  status?: PlanStatus | null;
  limit?: number;
  offset?: number;
}

export async function listPlans(filter: ListPlansFilter) {
  const db = requireDb();
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  const wheres = [];
  if (filter.branchId != null) wheres.push(eq(installmentPlans.branchId, filter.branchId));
  if (filter.customerId != null) wheres.push(eq(installmentPlans.customerId, filter.customerId));
  if (filter.status) wheres.push(eq(installmentPlans.status, filter.status));

  // limit+1 ⇒ hasMore بلا COUNT (نمط حملة الأداء).
  const rows = await db
    .select({
      plan: installmentPlans,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(installmentPlans)
    .innerJoin(customers, eq(installmentPlans.customerId, customers.id))
    .where(wheres.length ? and(...wheres) : undefined)
    .orderBy(desc(installmentPlans.id))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const planIds = page.map((r) => Number(r.plan.id));

  // تجميع تقدّم الأقساط لخطط الصفحة فقط.
  const aggMap = new Map<number, { totalLines: number; paidLines: number; paidAmount: string; nextDueDate: string | null }>();
  if (planIds.length > 0) {
    const aggs = await db
      .select({
        planId: installmentLines.planId,
        totalLines: sql<number>`COUNT(*)`,
        paidLines: sql<number>`SUM(CASE WHEN ${installmentLines.status} = 'PAID' THEN 1 ELSE 0 END)`,
        paidAmount: sql<string>`COALESCE(SUM(CASE WHEN ${installmentLines.status} = 'PAID' THEN ${installmentLines.amount} ELSE 0 END), 0)`,
        // DATE_FORMAT ⇒ سلسلة YYYY-MM-DD حتمياً (raw sql يتجاوز mapping عمود date mode:"string").
        nextDueDate: sql<string | null>`DATE_FORMAT(MIN(CASE WHEN ${installmentLines.status} IN ('PENDING','BOUNCED') THEN ${installmentLines.dueDate} END), '%Y-%m-%d')`,
      })
      .from(installmentLines)
      .where(inArray(installmentLines.planId, planIds))
      .groupBy(installmentLines.planId);
    for (const a of aggs) {
      aggMap.set(Number(a.planId), {
        totalLines: Number(a.totalLines),
        paidLines: Number(a.paidLines ?? 0),
        paidAmount: toDbMoney(a.paidAmount ?? "0"),
        nextDueDate: a.nextDueDate ?? null,
      });
    }
  }

  return {
    rows: page.map((r) => {
      const agg = aggMap.get(Number(r.plan.id)) ?? { totalLines: 0, paidLines: 0, paidAmount: "0.00", nextDueDate: null };
      return {
        id: Number(r.plan.id),
        customerId: Number(r.plan.customerId),
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        invoiceId: r.plan.invoiceId != null ? Number(r.plan.invoiceId) : null,
        branchId: Number(r.plan.branchId),
        totalAmount: r.plan.totalAmount,
        downPayment: r.plan.downPayment,
        status: r.plan.status as PlanStatus,
        notes: r.plan.notes,
        createdAt: r.plan.createdAt,
        ...agg,
      };
    }),
    hasMore,
  };
}

/** تفاصيل خطة بأقساطها (مرتّبة seq) — للراوتر get مع عزل الفرع. */
export async function getPlan(planId: number, restrictToBranchId: BranchRestriction = null) {
  const db = requireDb();
  const row = (
    await db
      .select({ plan: installmentPlans, customerName: customers.name, customerPhone: customers.phone })
      .from(installmentPlans)
      .innerJoin(customers, eq(installmentPlans.customerId, customers.id))
      .where(eq(installmentPlans.id, planId))
      .limit(1)
  )[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "الخطة غير موجودة" });
  assertPlanBranch(Number(row.plan.branchId), restrictToBranchId);
  const lines = await db
    .select()
    .from(installmentLines)
    .where(eq(installmentLines.planId, planId))
    .orderBy(asc(installmentLines.seq));
  return {
    ...row.plan,
    id: Number(row.plan.id),
    customerId: Number(row.plan.customerId),
    branchId: Number(row.plan.branchId),
    invoiceId: row.plan.invoiceId != null ? Number(row.plan.invoiceId) : null,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    lines: lines.map((l) => ({ ...l, id: Number(l.id), planId: Number(l.planId), receiptId: l.receiptId != null ? Number(l.receiptId) : null })),
  };
}

/** طابور التحصيل: أقساط PENDING مستحقّة خلال N أيام أو متأخّرة — الأشد تأخّراً أولاً. */
export async function dueSoon(filter: { branchId?: number | null; days?: number }) {
  const db = requireDb();
  const days = Math.min(Math.max(filter.days ?? 7, 0), 90);
  const today = toDateStr();
  const horizon = toDateStr(new Date(Date.now() + days * 86_400_000));

  const wheres = [
    eq(installmentLines.status, "PENDING"),
    eq(installmentPlans.status, "ACTIVE"),
    lte(installmentLines.dueDate, horizon),
  ];
  if (filter.branchId != null) wheres.push(eq(installmentPlans.branchId, filter.branchId));

  const rows = await db
    .select({
      line: installmentLines,
      planId: installmentPlans.id,
      branchId: installmentPlans.branchId,
      customerId: installmentPlans.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(installmentLines)
    .innerJoin(installmentPlans, eq(installmentLines.planId, installmentPlans.id))
    .innerJoin(customers, eq(installmentPlans.customerId, customers.id))
    .where(and(...wheres))
    .orderBy(asc(installmentLines.dueDate), asc(installmentLines.id))
    .limit(200);

  return rows.map((r) => {
    const overdueMs = new Date(`${today}T00:00:00Z`).getTime() - new Date(`${r.line.dueDate}T00:00:00Z`).getTime();
    const daysOverdue = Math.max(0, Math.round(overdueMs / 86_400_000));
    return {
      lineId: Number(r.line.id),
      planId: Number(r.planId),
      branchId: Number(r.branchId),
      customerId: Number(r.customerId),
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      seq: r.line.seq,
      dueDate: r.line.dueDate,
      amount: r.line.amount,
      kind: r.line.kind as InstallmentKind,
      checkNumber: r.line.checkNumber,
      bankName: r.line.bankName,
      daysOverdue,
    };
  });
}
