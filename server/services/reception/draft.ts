// ش٢ — دورة حياة مسوّدة طلب المحطة (م١: تعديلٌ حرّ قبل التثبيت بصفر أثرٍ ماليّ).
// docs/reception-cashier-system-design-2026-08-05.md §٥.١-٥.٢ + §٦ + §٨.٢.
//
// الثوابت الحاكمة هنا:
//  I1  — لا كتابة في invoices/accountingEntries/inventoryMovements إطلاقاً من هذا الملف.
//  I9  — `version` تفاؤليّ: تعديلان متوازيان لا يطمس أحدهما الآخر (الثاني CONFLICT).
//  I3  — هيكل حارس moneyLocked جاهز (يُفعَّل مالياً في ش٤): مسوّدةٌ مموّلة لا يُحذف بندها
//        ولا يُخفَض إجماليها دون المقبوض، وإلغاؤها مديريّ.
//  I22 — التدقيق يحمل قبل/بعد ولا يحمل designImages/printSpec أبداً.
//  ق٤  — الفارغة تنقضي بعد ٢٤ ساعة (تتجدّد بكل نشاط)؛ المموّلة لا تُطوى أبداً.
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, like, lt, or, sql, type SQL } from "drizzle-orm";
import {
  auditLogs,
  orderPayments,
  receptionDraftLines,
  receptionDrafts,
  users,
} from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { paginateKeyset } from "../../lib/paginateKeyset";
import { escLike } from "../../lib/sqlLike";
import { money, round2, toDateStr, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { heldNetOfDraft } from "./deposits";

export interface DraftLineInput {
  lineKind: "GOODS" | "PRINT" | "CUSTOM";
  sortOrder?: number;
  variantId?: number | null;
  productUnitId?: number | null;
  quantity: string;
  unitPrice: string;
  discountAmount?: string | null;
  title?: string | null;
  customizationText?: string | null;
  designImages?: string | null; // JSON [{url,caption,sortOrder}] — لا يُنتقى في القوائم (I22)
  printSpec?: string | null; // JSON بنية CustomizationData عدا الصور
  dueDate?: string | null;
  assignedTo?: number | null;
  priceOverride?: boolean;
  lineRequestId?: string | null;
}

export interface DraftHeaderInput {
  customerId?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  priceTier?: "RETAIL" | "WHOLESALE" | "GOVERNMENT" | null;
  channel?: string | null;
  notes?: string | null;
  dueDate?: string | null;
}

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // ق٤ — مُعتمَد افتراضياً

/** DRF-{فرع}-{YYYYMMDD}-{NNNNN} تحت قفل (نمط nextWorkOrderNumber حرفياً). */
async function nextDraftNumber(tx: Tx, branchId: number): Promise<string> {
  const ymd = toDateStr().replace(/-/g, "");
  const prefix = `DRF-${branchId}-${ymd}-`;
  const rows = await tx
    .select({ n: receptionDrafts.draftNumber })
    .from(receptionDrafts)
    .where(like(receptionDrafts.draftNumber, `${prefix}%`))
    .orderBy(desc(receptionDrafts.id))
    .for("update")
    .limit(1);
  const last = rows[0]?.n;
  const seq = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(seq).padStart(5, "0");
}

/** إعادة الحساب الخادمية — الإجماليات المخزَّنة ذاكرةُ عرضٍ لا مصدرُ قرار (§٥.١). */
function computeTotals(lines: DraftLineInput[]) {
  let subtotal = money("0");
  let discountTotal = money("0");
  for (const line of lines) {
    const qty = money(line.quantity);
    const gross = round2(money(line.unitPrice).times(qty));
    const disc = round2(money(line.discountAmount ?? "0"));
    subtotal = subtotal.plus(gross);
    discountTotal = discountTotal.plus(disc);
  }
  subtotal = round2(subtotal);
  discountTotal = round2(discountTotal);
  return { subtotal, discountTotal, total: round2(subtotal.minus(discountTotal)) };
}

function lineRowValues(draftId: number, line: DraftLineInput, index: number) {
  const qty = money(line.quantity);
  const gross = round2(money(line.unitPrice).times(qty));
  const disc = round2(money(line.discountAmount ?? "0"));
  return {
    draftId,
    lineKind: line.lineKind,
    sortOrder: line.sortOrder ?? index,
    variantId: line.variantId ?? null,
    productUnitId: line.productUnitId ?? null,
    quantity: qty.toFixed(3),
    unitPrice: toDbMoney(round2(money(line.unitPrice))),
    discountAmount: toDbMoney(disc),
    lineTotal: toDbMoney(round2(gross.minus(disc))),
    title: line.title?.trim() || null,
    customizationText: line.customizationText ?? null,
    designImages: line.designImages ?? null,
    printSpec: line.printSpec ?? null,
    dueDate: line.dueDate ? new Date(line.dueDate) : null,
    assignedTo: line.assignedTo ?? null,
    priceOverride: !!line.priceOverride,
    lineRequestId: line.lineRequestId ?? null,
  };
}

/** ملخّص تدقيقٍ آمن (I22): عناوين ومبالغ فقط — لا صور ولا مواصفات. */
function auditLineSummary(lines: Array<{ title: string | null; unitPrice: string; quantity: string; lineTotal: string }>) {
  return lines.map((l) => ({ title: l.title, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: l.lineTotal }));
}

export async function promoteDraft(
  input: { branchId: number; shiftId?: number | null; header: DraftHeaderInput; lines: DraftLineInput[] },
  actor: Actor & { role?: string },
) {
  return withTx(async (tx) => {
    const draftNumber = await nextDraftNumber(tx, input.branchId);
    const totals = computeTotals(input.lines);
    const commitRequestId = crypto.randomUUID();
    const res = await tx.insert(receptionDrafts).values({
      draftNumber,
      branchId: input.branchId,
      createdByShiftId: input.shiftId ?? null,
      commitRequestId,
      customerId: input.header.customerId ?? null,
      contactName: input.header.contactName?.trim() || null,
      contactPhone: input.header.contactPhone?.trim() || null,
      priceTier: input.header.priceTier ?? "RETAIL",
      channel: input.header.channel ?? null,
      notes: input.header.notes ?? null,
      dueDate: input.header.dueDate ? new Date(input.header.dueDate) : null,
      subtotal: toDbMoney(totals.subtotal),
      discountTotal: toDbMoney(totals.discountTotal),
      total: toDbMoney(totals.total),
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
      createdBy: actor.userId,
    });
    const draftId = extractInsertId(res);
    for (let i = 0; i < input.lines.length; i += 1) {
      await tx.insert(receptionDraftLines).values(lineRowValues(draftId, input.lines[i], i));
    }
    return { draftId, draftNumber, version: 0, total: totals.total.toFixed(2) };
  });
}

/** مزامنة **بالجملة** (§٦): المصفوفة كاملةً تستبدل الأسطر — لا سطراً-سطراً (يهدم مسح الباركود السريع). */
export async function syncDraft(
  input: { draftId: number; version: number; header: DraftHeaderInput; lines: DraftLineInput[] },
  actor: Actor & { role?: string },
) {
  return withTx(async (tx) => {
    const row = (
      await tx.select().from(receptionDrafts).where(eq(receptionDrafts.id, input.draftId)).for("update").limit(1)
    )[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "المسوّدة غير موجودة" });
    assertDraftBranch(row, actor);
    if (row.status !== "OPEN") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: draftClosedMessage(row.status) });
    }
    if (Number(row.version) !== input.version) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "حدّث المسوّدةَ زميلٌ آخر للتوّ — أُعيد تحميلها، راجعها ثم تابع",
      });
    }
    const totals = computeTotals(input.lines);
    // I3 (ش٤ — بالجمع الفعليّ): مسوّدة مموّلة (أ) لا يُحذف بندٌ منها (المال قُبض على سلةٍ
    // بعينها — الحذف بابُ «اقبض ٣٠٠ﻙ ثم صفّر السلة») و(ب) لا يهبط إجماليها دون صافي المقبوض.
    if (row.moneyLocked) {
      const existingCount = (
        await tx
          .select({ n: sql<number>`COUNT(*)` })
          .from(receptionDraftLines)
          .where(eq(receptionDraftLines.draftId, input.draftId))
      )[0];
      if (input.lines.length < Number(existingCount?.n ?? 0)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "الطلب عليه مبلغٌ مقبوض — لا يُحذف بندٌ منه؛ ردّ العربون أولاً أو أكمل بالإلغاء المديريّ",
        });
      }
      const heldNet = await heldNetOfDraft(tx, input.draftId);
      if (totals.total.lt(heldNet)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `الإجمالي الجديد (${totals.total.toFixed(2)}) أقل من المقبوض سلفاً (${heldNet.toFixed(2)}) — ردّ الفارق أولاً (ردّ عربون)`,
        });
      }
      // مراجعة ش٤ (ج): قيود العربون مختومة بعميل لحظة قبضه (PAYMENT_IN + سطر إفصاح I11) —
      // تغييرُ عميل مسوّدةٍ عليها محتجزٌ يفصم القيد عن الفاتورة اللاحقة فيكذب AR الفرعيّ
      // المشتقّ **دائماً** (عميلٌ يُطالَب بما سدّده). الردّ أولاً ثم التغيير.
      if (heldNet.gt(0)) {
        const currentCustomer = row.customerId != null ? Number(row.customerId) : null;
        const nextCustomer = input.header.customerId ?? null;
        if (nextCustomer !== currentCustomer) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "الطلب عليه مبلغٌ مقبوض باسم طرفه الحاليّ — رُدَّ العربون أولاً ثم غيّر العميل",
          });
        }
      }
    }

    const before = await tx
      .select({
        title: receptionDraftLines.title,
        unitPrice: receptionDraftLines.unitPrice,
        quantity: receptionDraftLines.quantity,
        lineTotal: receptionDraftLines.lineTotal,
      })
      .from(receptionDraftLines)
      .where(eq(receptionDraftLines.draftId, input.draftId));

    // ش٦ (كاشف «خفض إجماليٍّ بعد قبض»): الخفض ضمن المسموح (فوق المحتجز) مشروعٌ لكنه إشارة
    // شذوذ تُسجَّل حدثَ تدقيقٍ داخل المعاملة — يقرؤه كاشف D12 (anomalyWatch) مجمَّعاً بالفاعل.
    if (row.moneyLocked && totals.total.lt(money(String(row.total)))) {
      await tx.insert(auditLogs).values({
        userId: actor.userId,
        branchId: Number(row.branchId),
        action: "reception.fundedTotalReduced",
        entityType: "receptionDraft",
        entityId: String(input.draftId),
        oldValue: JSON.stringify({ total: String(row.total) }),
        newValue: JSON.stringify({ total: totals.total.toFixed(2) }),
      });
    }

    await tx.delete(receptionDraftLines).where(eq(receptionDraftLines.draftId, input.draftId));
    for (let i = 0; i < input.lines.length; i += 1) {
      await tx.insert(receptionDraftLines).values(lineRowValues(input.draftId, input.lines[i], i));
    }
    const nextVersion = Number(row.version) + 1;
    await tx
      .update(receptionDrafts)
      .set({
        version: nextVersion,
        customerId: input.header.customerId ?? null,
        contactName: input.header.contactName?.trim() || null,
        contactPhone: input.header.contactPhone?.trim() || null,
        priceTier: input.header.priceTier ?? row.priceTier,
        channel: input.header.channel ?? row.channel,
        notes: input.header.notes ?? row.notes,
        dueDate: input.header.dueDate ? new Date(input.header.dueDate) : row.dueDate,
        subtotal: toDbMoney(totals.subtotal),
        discountTotal: toDbMoney(totals.discountTotal),
        total: toDbMoney(totals.total),
        // ق٤: النشاط يجدّد النافذة (المموّلة لا تُطوى أصلاً — الكنّاس يتجاوزها).
        expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
        updatedBy: actor.userId,
      })
      .where(eq(receptionDrafts.id, input.draftId));

    return {
      version: nextVersion,
      totals: {
        subtotal: totals.subtotal.toFixed(2),
        discountTotal: totals.discountTotal.toFixed(2),
        total: totals.total.toFixed(2),
      },
      auditBefore: { total: String(row.total), lines: auditLineSummary(before as never) },
    };
  });
}

export async function getDraft(draftId: number, actor: Actor & { role?: string }) {
  const db = getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير مهيّأة" });
  const row = (await db.select().from(receptionDrafts).where(eq(receptionDrafts.id, draftId)).limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "المسوّدة غير موجودة" });
  assertDraftBranch(row, actor);
  const owner = (await db.select({ name: users.name }).from(users).where(eq(users.id, Number(row.createdBy))).limit(1))[0];
  // get المفرد يحمل الصور والمواصفة (الاستئناف الوفيّ) — القوائم لا تنتقيها أبداً (I22).
  const lines = await db
    .select()
    .from(receptionDraftLines)
    .where(eq(receptionDraftLines.draftId, draftId))
    .orderBy(receptionDraftLines.sortOrder, receptionDraftLines.id);
  // ش٤: صافي المحتجز — تعتمده الشاشة («مقبوض سلفاً») وتقلّص به «المتوقّع الآن».
  const opRows = await db
    .select({ kind: orderPayments.kind, amount: orderPayments.amount })
    .from(orderPayments)
    .where(and(eq(orderPayments.draftId, draftId), inArray(orderPayments.kind, ["COLLECTION", "REFUND"])));
  let heldNet = money(0);
  for (const r of opRows) {
    heldNet = r.kind === "COLLECTION" ? heldNet.plus(money(r.amount)) : heldNet.minus(money(r.amount));
  }
  return { ...row, ownerName: owner?.name ?? null, lines, heldTotal: toDbMoney(round2(heldNet)) };
}

export async function listDrafts(
  input: { branchId: number; mine?: boolean; status?: "OPEN" | "COMMITTED" | "CANCELLED" | "EXPIRED"; q?: string; cursor?: number; limit?: number },
  actor: Actor & { role?: string },
) {
  const db = getDb();
  if (!db) return { rows: [], hasMore: false, nextCursor: null as number | null };
  const baseConds: SQL[] = [eq(receptionDrafts.branchId, input.branchId)];
  if (input.mine) baseConds.push(eq(receptionDrafts.createdBy, actor.userId));
  baseConds.push(eq(receptionDrafts.status, input.status ?? "OPEN"));
  const q = input.q?.trim();
  if (q) {
    const pat = `%${escLike(q)}%`;
    const cond = or(
      like(receptionDrafts.draftNumber, pat),
      like(receptionDrafts.contactName, pat),
      like(receptionDrafts.contactPhone, pat),
    );
    if (cond) baseConds.push(cond);
  }
  const linesCount = sql<number>`(SELECT COUNT(*) FROM receptionDraftLines l WHERE l.draftId = ${receptionDrafts.id})`;
  // ش٤: صافي المحتجز لكل مسوّدة (COLLECTION − REFUND) — تعرضه الرقاقة/الاستئناف. أسماء أعمدة
  // DB الحرفية (orderPayKind) لا أسماء TS — raw SQL (فخّ موثَّق).
  const heldTotal = sql<string>`CAST((SELECT COALESCE(SUM(CASE WHEN op.orderPayKind = 'COLLECTION' THEN op.amount WHEN op.orderPayKind = 'REFUND' THEN -op.amount ELSE 0 END), 0) FROM orderPayments op WHERE op.draftId = ${receptionDrafts.id}) AS CHAR)`;
  const page = await paginateKeyset({
    cursor: input.cursor,
    limit: input.limit,
    defaultLimit: 20,
    idCol: receptionDrafts.id,
    baseConds,
    runQuery: (where, fetchLimit, fetchOffset) =>
      db
        .select({
          id: receptionDrafts.id,
          draftNumber: receptionDrafts.draftNumber,
          status: receptionDrafts.status,
          version: receptionDrafts.version,
          moneyLocked: receptionDrafts.moneyLocked,
          customerId: receptionDrafts.customerId,
          contactName: receptionDrafts.contactName,
          contactPhone: receptionDrafts.contactPhone,
          total: receptionDrafts.total,
          createdBy: receptionDrafts.createdBy,
          ownerName: users.name,
          createdAt: receptionDrafts.createdAt,
          updatedAt: receptionDrafts.updatedAt,
          linesCount,
          heldTotal,
        })
        .from(receptionDrafts)
        .leftJoin(users, eq(users.id, receptionDrafts.createdBy))
        .where(where)
        .orderBy(desc(receptionDrafts.id))
        .limit(fetchLimit)
        .offset(fetchOffset),
  });
  return { rows: page.rows, hasMore: page.hasMore, nextCursor: page.nextCursor };
}

export async function cancelDraft(
  input: { draftId: number; version: number; reason: string },
  actor: Actor & { role?: string },
) {
  return withTx(async (tx) => {
    const row = (
      await tx.select().from(receptionDrafts).where(eq(receptionDrafts.id, input.draftId)).for("update").limit(1)
    )[0];
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "المسوّدة غير موجودة" });
    assertDraftBranch(row, actor);
    if (row.status !== "OPEN") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: draftClosedMessage(row.status) });
    }
    if (Number(row.version) !== input.version) {
      throw new TRPCError({ code: "CONFLICT", message: "حدّث المسوّدةَ زميلٌ آخر — أعد فتحها قبل الإلغاء" });
    }
    // I3/§٩.٣: إلغاء مسوّدةٍ **مموّلة** مديريٌّ حصراً (المال في receipts — الردّ مساره ش٤).
    const elevated = actor.role === "admin" || actor.role === "manager";
    if (row.moneyLocked && !elevated) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "المسوّدة عليها مبلغٌ مقبوض — إلغاؤها يتطلّب مديراً (ويُردّ المبلغ بمساره الموثَّق)",
      });
    }
    // ش٤ (I17): لا يُلغى طلبٌ وعليه مالٌ محتجز — يُدفن المال بلا وعاءٍ ولا مخرج. الردّ أولاً
    // (refundDeposit: OUT موثَّق مربوط بإيصال قبضه) ثم الإلغاء المديريّ بسببه.
    if (row.moneyLocked) {
      const heldNet = await heldNetOfDraft(tx, input.draftId);
      if (heldNet.gt(0)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `على الطلب مبلغٌ محتجز (${heldNet.toFixed(2)}) — رُدَّه أولاً (ردّ عربون) ثم ألغِ`,
        });
      }
    }
    await tx
      .update(receptionDrafts)
      .set({ status: "CANCELLED", cancelledAt: new Date(), cancelReason: input.reason.trim(), updatedBy: actor.userId })
      .where(eq(receptionDrafts.id, input.draftId));
    return { draftId: input.draftId, status: "CANCELLED" as const };
  });
}

/** كنّاس ق٤: يطوي الفارغة المنقضية فقط — **لا يمسّ المموّلة أبداً** (I14). idempotent. */
export async function sweepExpiredDrafts(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const res = await db
    .update(receptionDrafts)
    .set({ status: "EXPIRED" })
    .where(and(
      eq(receptionDrafts.status, "OPEN"),
      eq(receptionDrafts.moneyLocked, false),
      lt(receptionDrafts.expiresAt, new Date()),
    ));
  return Number((res as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
}

function assertDraftBranch(row: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  if (actor.branchId == null || Number(row.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "المسوّدة تخصّ فرعاً آخر" });
  }
}

function draftClosedMessage(status: string): string {
  return status === "COMMITTED"
    ? "المسوّدة ثُبِّتت فاتورةً — افتح الفاتورة من ورشة الفواتير"
    : status === "CANCELLED"
      ? "المسوّدة أُلغيت"
      : "المسوّدة انقضت صلاحيتها (٢٤ ساعة بلا نشاط) — أنشئ طلباً جديداً";
}
