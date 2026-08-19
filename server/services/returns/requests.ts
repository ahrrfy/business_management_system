/**
 * **طلبات الإرجاع من المحطة** (١٩/٨) — قرار المالك: «طلب موظف + اعتماد مدير».
 *
 * البلاغ: «العملاء يرفضون الطلبات أو يلغونها… فيرجع المندوب الفاتورة والطلب إلى المكتبة»
 * — حدثٌ يوميّ. و`returns.create` محصورٌ بالمدير، وطابور المحطة يقول للموظّف حرفياً
 * «التصحيح بمرتجعٍ (المدير)». فإمّا يتوقّف العمل حتى يحضر، أو يُحفَظ المرتجع بحسابه
 * فتضيع نسبةُ الفاعل الحقيقيّ ويسقط فصلُ المهام معاً.
 *
 * التصميم — مستنسَخٌ من `stockAdjustmentRequests` (ماكر-تشيكر مُختبَر في هذا المستودع):
 *  ① **الطلب مستند نيّةٍ لا مال**: صفٌّ واحد. لا قيد، لا إيصال، لا حركة مخزون، ولا لمسٌ
 *    لأيّ رصيد — فخطأُ الموظّف يُرفَض برفضٍ لا بعكسٍ محاسبيّ.
 *  ② **الاعتماد ينفّذ المسار القائم بحرفه** (`returns.create`): لا نسخةَ منطقٍ ماليّ ثانية
 *    تنجرف؛ المدير يقرّر لحظتَها الرافد والدرج والمرجع كما يفعل اليوم.
 *  ③ **لقطة تفاؤلية** على `returnedTotal`: يُرفَض الاعتماد إن تحرّك مرتجع الفاتورة بين
 *    الطلب والاعتماد — وإلّا اعتُمد طلبٌ بُني على حالةٍ لم تعد قائمة فانعكس البيع مرّتين.
 *  ④ **المُعتمِد ≠ المُنشئ** (admin مستثنى للتصحيح الإداريّ — نفس قاعدة SOD السارية).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { invoiceItems, invoices, returnRequests, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { isDeadInvoiceStatus, invoiceStatusLabel } from "@shared/invoiceStatus";
import { money, round2 } from "../money";
import type { Actor } from "../tx";

export interface ReturnRequestLine {
  invoiceItemId: number;
  baseQuantity: number;
}

export interface CreateReturnRequestInput {
  invoiceId: number;
  lines: ReturnRequestLine[];
  reason: string;
}

function db() {
  const d = getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  return d;
}

/** يُنشئ طلب إرجاع — **بلا أيّ أثرٍ ماليّ أو مخزنيّ**. */
export async function createReturnRequest(input: CreateReturnRequestInput, actor: Actor & { role?: string }) {
  const d = db();
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الإرجاع مطلوب (رفض العميل، صنف خاطئ، تلف…)" });
  }
  if (!input.lines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد الأصناف المُرجَعة" });
  }

  const inv = (await d.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  // عزل الفرع: الموظّف لا يطلب إرجاعاً على فاتورة فرعٍ آخر (مرآة حرّاس المرتجع نفسه).
  if (actor.branchId != null && actor.role !== "admin" && Number(inv.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة تخصّ فرعاً آخر" });
  }
  if (isDeadInvoiceStatus(inv.status)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `الفاتورة ${invoiceStatusLabel(inv.status)} — لا يُطلَب إرجاعٌ عليها`,
    });
  }

  // الأسطر تخصّ هذه الفاتورة، والكميات ضمن المتبقّي (تحقّقٌ استرشاديّ؛ الحسم عند التنفيذ).
  const itemIds = input.lines.map((l) => Number(l.invoiceItemId));
  const items = await d
    .select({
      id: invoiceItems.id,
      invoiceId: invoiceItems.invoiceId,
      baseQuantity: invoiceItems.baseQuantity,
      returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
    })
    .from(invoiceItems)
    .where(inArray(invoiceItems.id, itemIds));
  const byId = new Map(items.map((i) => [Number(i.id), i]));
  for (const line of input.lines) {
    const item = byId.get(Number(line.invoiceItemId));
    if (!item || Number(item.invoiceId) !== Number(input.invoiceId)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `البند ${line.invoiceItemId} لا يخصّ هذه الفاتورة` });
    }
    const remaining = Number(item.baseQuantity) - Number(item.returnedBaseQuantity ?? 0);
    if (line.baseQuantity <= 0 || line.baseQuantity > remaining) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `كمية البند ${line.invoiceItemId} خارج المتبقّي القابل للإرجاع (${remaining})`,
      });
    }
  }

  // طلبٌ معلَّقٌ قائمٌ على نفس الفاتورة ⇒ لا تُكدَّس الطلبات (المدير يحسم القائم أولاً).
  const pending = (await d
    .select({ id: returnRequests.id })
    .from(returnRequests)
    .where(and(
      eq(returnRequests.invoiceId, input.invoiceId),
      eq(returnRequests.status, "PENDING_APPROVAL"),
    ))
    .limit(1))[0];
  if (pending) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `على هذه الفاتورة طلبُ إرجاعٍ معلَّقٌ (#${pending.id}) بانتظار المدير`,
    });
  }

  const res = await d.insert(returnRequests).values({
    invoiceId: input.invoiceId,
    branchId: Number(inv.branchId),
    linesJson: input.lines.map((l) => ({
      invoiceItemId: Number(l.invoiceItemId),
      baseQuantity: Number(l.baseQuantity),
    })),
    reason,
    invoiceReturnedSnapshot: round2(money(inv.returnedTotal ?? "0")).toFixed(2),
    createdBy: actor.userId,
  });
  const id = Number((res as unknown as { insertId: number }).insertId
    ?? (res as unknown as [{ insertId: number }])[0]?.insertId);
  return { requestId: id, status: "PENDING_APPROVAL" as const };
}

/** قائمة الطلبات — للمدير (كلّ فرعه) وللموظّف (طلباته وحدها). */
export async function listReturnRequests(opts: {
  branchId: number | null;
  status?: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  createdBy?: number | null;
}) {
  const d = db();
  const conds = [];
  if (opts.branchId != null) conds.push(eq(returnRequests.branchId, opts.branchId));
  if (opts.status) conds.push(eq(returnRequests.status, opts.status));
  if (opts.createdBy != null) conds.push(eq(returnRequests.createdBy, opts.createdBy));
  return d
    .select({
      id: returnRequests.id,
      invoiceId: returnRequests.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      customerId: invoices.customerId,
      invoiceTotal: invoices.total,
      invoicePaid: invoices.paidAmount,
      branchId: returnRequests.branchId,
      linesJson: returnRequests.linesJson,
      reason: returnRequests.reason,
      status: returnRequests.status,
      createdBy: returnRequests.createdBy,
      createdByName: users.name,
      createdAt: returnRequests.createdAt,
      approvedBy: returnRequests.approvedBy,
      approvedAt: returnRequests.approvedAt,
      rejectionReason: returnRequests.rejectionReason,
    })
    .from(returnRequests)
    .leftJoin(invoices, eq(invoices.id, returnRequests.invoiceId))
    .leftJoin(users, eq(users.id, returnRequests.createdBy))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(returnRequests.id))
    .limit(200);
}

/**
 * يقرأ طلباً معلَّقاً ويتحقّق من صلاحيته للاعتماد — **بلا تنفيذ**.
 * التنفيذ الماليّ يبقى في `returns.create` القائم كي لا يوجد مسارٌ ماليّ ثانٍ.
 */
export async function loadApprovableRequest(requestId: number, actor: Actor & { role?: string }) {
  const d = db();
  const req = (await d.select().from(returnRequests).where(eq(returnRequests.id, requestId)).limit(1))[0];
  if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الإرجاع غير موجود" });
  if (req.status !== "PENDING_APPROVAL") {
    throw new TRPCError({ code: "CONFLICT", message: "الطلب محسومٌ سلفاً" });
  }
  if (actor.branchId != null && actor.role !== "admin" && Number(req.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
  }
  // فصل المهام: المُعتمِد ≠ المُنشئ (admin مستثنى للتصحيح الإداريّ — نفس قاعدة الصرف والجرد).
  if (actor.role !== "admin" && Number(req.createdBy) === Number(actor.userId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا تعتمد طلبك بنفسك — يعتمده مديرٌ آخر (فصل المهام)",
    });
  }
  const inv = (await d.select().from(invoices).where(eq(invoices.id, Number(req.invoiceId))).limit(1))[0];
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الطلب غير موجودة" });
  // الحارس التفاؤليّ: تحرّكُ مرتجع الفاتورة بين الطلب والاعتماد يُبطل الطلب — الكميات
  // المطلوبة بُنيت على حالةٍ لم تعد قائمة، واعتمادُها يعكس البيع مرّتين.
  const liveReturned = round2(money(inv.returnedTotal ?? "0"));
  if (!liveReturned.eq(round2(money(req.invoiceReturnedSnapshot)))) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `تغيّر مرتجع الفاتورة منذ الطلب (${req.invoiceReturnedSnapshot} ← ${liveReturned.toFixed(2)}) — أعِد الطلب بالكميات الصحيحة`,
    });
  }
  return {
    request: req,
    lines: (req.linesJson as ReturnRequestLine[]) ?? [],
    invoiceId: Number(req.invoiceId),
  };
}

/** يختم الطلب مُعتمَداً بعد تنفيذ المرتجع فعلياً (يُستدعى من الراوتر بعد `returns.create`). */
export async function markRequestApproved(requestId: number, actorUserId: number, resultInvoiceId: number | null) {
  await db()
    .update(returnRequests)
    .set({
      status: "APPROVED",
      approvedBy: actorUserId,
      approvedAt: new Date(),
      resultReturnInvoiceId: resultInvoiceId,
    })
    .where(eq(returnRequests.id, requestId));
}

/** يرفض الطلب بسببٍ إلزاميّ — الموظّف يرى لماذا. */
export async function rejectReturnRequest(
  requestId: number,
  reason: string,
  actor: Actor & { role?: string },
) {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الرفض مطلوب — الموظّف يحتاج معرفة لماذا" });
  }
  await loadApprovableRequest(requestId, actor);
  await db()
    .update(returnRequests)
    .set({
      status: "REJECTED",
      approvedBy: actor.userId,
      approvedAt: new Date(),
      rejectionReason: trimmed,
    })
    .where(eq(returnRequests.id, requestId));
  return { requestId, status: "REJECTED" as const };
}
