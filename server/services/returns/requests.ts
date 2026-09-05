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
 *  ④ **المُعتمِد ≠ المُنشئ ومُنشئ الفاتورة** بلا استثناءٍ إداريّ؛ الصلاحية لا تلغي فصل المهام.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { invoiceItems, invoices, returnRequests, salesControlRequests, users,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { extractAffectedRows } from "../../lib/insertId";
import { invoiceStatusLabel } from "@shared/invoiceStatus";
import { isDeadInvoice } from "@shared/predicates";
import { money, round2 } from "../money";
import { withTx, type Actor } from "../tx";
import type { Tx } from "../../db";

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
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة",
    });
  return d;
}

/** يُنشئ طلب إرجاع — **بلا أيّ أثرٍ ماليّ أو مخزنيّ**. */
export async function createReturnRequest(input: CreateReturnRequestInput, actor: Actor & { role?: string },
) {
  const d = db();
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الإرجاع مطلوب (رفض العميل، صنف خاطئ، تلف…)",
    });
  }
  if (!input.lines.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "حدّد الأصناف المُرجَعة",
    });
  }

  const inv = (await d.select().from(invoices).where(eq(invoices.id, input.invoiceId)).limit(1))[0];
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "الفاتورة غير موجودة" });
  // عزل الفرع: الموظّف لا يطلب إرجاعاً على فاتورة فرعٍ آخر (مرآة حرّاس المرتجع نفسه).
  if (actor.branchId != null && actor.role !== "admin" && Number(inv.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الفاتورة تخصّ فرعاً آخر",
    });
  }
  if (isDeadInvoice(inv)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `الفاتورة ${invoiceStatusLabel(inv.status)} — لا يُطلَب إرجاعٌ عليها`,
    });
  }
  /**
   * ⭐ فاتورة أمر الشغل خارج هذا الطابور (تدقيق ١/٩/٢٦).
   *
   * المسارات الثلاثة الأخرى ترفضها صراحةً (`requestSalesControl` و`sales.cancel` و`sales.correct`)
   * لأنّ **`workOrders.reverseDelivery` هو المخرج الوحيد لأمرٍ مُسلَّم** — وحدَه يعكس COGS/WIP
   * ويقيّد هدر الخامة ويُعيد فتح العربون. وكان هذا الطابورُ وحدَه بلا حارس: يعتمده المدير
   * فيُنفَّذ `returnSaleInTx` على الفاتورة (إيرادٌ وذمّةٌ معكوسان، الحالة RETURNED) بينما
   * `workOrders.status` يبقى DELIVERED — مستندان متناقضان، و`reverseDelivery` يُقفَل بعدها
   * إلى الأبد («فاتورة أمر الشغل معكوسة أو ملغاة سلفاً») ⇒ عربونٌ محتجَزٌ بلا مخرج.
   *
   * ⛔ الحارس هنا لا في `returnSaleInTx`: النواة تخدم أيضاً مسارَي **التوصيل** الشرعيَّين
   * (`failCourierDelivery` و`reverseDispatchedInvoice`)، وفواتير `delivery/dispatch.ts:335`
   * تحمل `sourceType="WORKORDER"` — فحارسٌ في النواة كان يكسر عكسَ طردٍ لم يُسلَّم أصلاً.
   */
  if (inv.sourceType === "WORKORDER") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "فاتورة أمر الشغل تُعالَج من شاشة أمر الشغل (عكس التسليم) — لا من طابور المرتجعات",
    });
  }
  /**
   * تماثلُ الحاجزَين: `assertApprovable` يرفض اعتماد هذا الطلب ما دام هناك طلب تحكّمٍ معلّق،
   * و`requestSalesControl` يرفض إنشاء طلبٍ محكومٍ فوق طلبٍ قديمٍ معلّق — لكنّ هذا الطرف كان
   * مفتوحاً، فيُنشَأ طلبٌ قديمٌ فوق طلبٍ محكوم فيقفل كلٌّ منهما اعتماد الآخر، والرسالتان تُحيل
   * كلٌّ منهما إلى الأخرى. المنعُ عند الإنشاء أرحم من حلقةٍ مغلقةٍ عند الاعتماد.
   */
  const governedPending = (await d
    .select({ id: salesControlRequests.id })
    .from(salesControlRequests)
    .where(and(
      eq(salesControlRequests.invoiceId, input.invoiceId),
      eq(salesControlRequests.status, "PENDING"),
    ))
    .limit(1))[0];
  if (governedPending) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `على هذه الفاتورة طلب تحكّمٍ معلّق (#${governedPending.id}) — احسمه من «طلبات العمليات» قبل طلبٍ جديد`,
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
      throw new TRPCError({ code: "BAD_REQUEST", message: `البند ${line.invoiceItemId} لا يخصّ هذه الفاتورة`,
      });
    }
    const remaining = Number(item.baseQuantity) - Number(item.returnedBaseQuantity ?? 0);
    if (line.baseQuantity <= 0 || line.baseQuantity > remaining) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `كمية البند ${line.invoiceItemId} خارج المتبقّي القابل للإرجاع (${remaining})`,
      });
    }
  }

  /**
   * ⭐ **الحارسان المتقابلان يتسلسلان على صفّ الفاتورة** (Codex، P2).
   *
   * فحصُ «طلبٌ معلّقٌ في الجدول الآخر» كان قراءةً حرّة خارج معاملة، فطلبٌ قديمٌ وطلبٌ محكومٌ
   * يبدآن متزامنين يريان كلاهما لا شيء ثمّ يُدرجان معاً — فيقفل كلٌّ منهما اعتمادَ الآخر.
   * القفلُ على `invoices` هو المِفتاح المشترك الوحيد بين الجدولين (لا قيدَ قاعدةٍ يجمعهما).
   */
  return withTx(async (tx) => {
    await tx.select({ id: invoices.id }).from(invoices)
      .where(eq(invoices.id, input.invoiceId)).for("update").limit(1);
    return insertReturnRequestTx(tx, input, actor, inv);
  }, { gate: "NONE" });
}

async function insertReturnRequestTx(
  d: Tx,
  input: CreateReturnRequestInput,
  actor: Actor & { role?: string },
  inv: { branchId: number | string; returnedTotal: string | null },
) {
  const reason = input.reason.trim();
  // طلبٌ معلَّقٌ قائمٌ على نفس الفاتورة ⇒ لا تُكدَّس الطلبات (المدير يحسم القائم أولاً).
  const pending = (await d
    .select({ id: returnRequests.id })
    .from(returnRequests)
    .where(and(
      eq(returnRequests.invoiceId, input.invoiceId),
      eq(returnRequests.status, "PENDING_APPROVAL"),
    ),
      )
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
    ?? (res as unknown as [{ insertId: number }])[0]?.insertId,
  );
  return { requestId: id, status: "PENDING_APPROVAL" as const };
}

/** قائمة الطلبات — للمدير (كلّ فرعه) وللموظّف (طلباته وحدها). */
export async function listReturnRequests(opts: {
  branchId: number | null;
  status?: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  createdBy?: number | null;
  /** `ASC` = الأقدم أوّلاً لصندوق القرارات — القصّ (200) بالأحدث يُسقط أكثر الطلبات تأخّراً. */
  order?: "ASC" | "DESC";
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
    .orderBy(opts.order === "ASC" ? asc(returnRequests.id) : desc(returnRequests.id))
    .limit(200);
}

/**
 * يقرأ طلباً معلَّقاً ويتحقّق من صلاحيته للاعتماد — **بلا تنفيذ**.
 * التنفيذ الماليّ يبقى في `returns.create` القائم كي لا يوجد مسارٌ ماليّ ثانٍ.
 */
/**
 * **اعتمادٌ ذرّيّ** (تصويب مراجعة Codex، ٢٠/٨): يقفل الطلب `FOR UPDATE` داخل معاملةٍ قائمة،
 * فيصير التحقّقُ والتنفيذُ والختمُ وحدةً واحدة.
 *
 * كان المسارُ ثلاثَ خطواتٍ منفصلة: `loadApprovableRequest` ثمّ `returnSale` (بمعاملتها
 * الخاصّة) ثمّ `markRequestApproved`. وفيه عطبان:
 *  · **فشلُ الختم بعد نجاح المرتجع** يترك الطلب معلَّقاً ومرتجعَه منفَّذاً — وإعادةُ
 *    المحاولة يرفضها الحارسُ التفاؤليّ لأنّ `returnedTotal` تغيّر ⇒ طريقٌ مسدود.
 *  · **معتمدان متزامنان** يقرآن الطلب معلَّقاً كلاهما فيُنفّذان المرتجع **مرّتين** ما دامت
 *    الكمّية تكفي.
 * القفلُ يحسم الثانية، ووحدةُ المعاملة تحسم الأولى.
 */
export async function loadApprovableRequestTx(
  tx: Tx,
  requestId: number,
  actor: Actor & { role?: string },
) {
  const req = (
    await tx.select().from(returnRequests).where(eq(returnRequests.id, requestId)).for("update").limit(1)
  )[0];
  return assertApprovable(tx, req, actor);
}

export async function loadApprovableRequest(requestId: number, actor: Actor & { role?: string },
) {
  const d = db();
  const req = (await d.select().from(returnRequests).where(eq(returnRequests.id, requestId)).limit(1))[0];
  return assertApprovable(d, req, actor);
}

/** التحقّقُ المشترك — يعمل على معاملةٍ أو على الاتصال المباشر بلا فرق. */
async function assertApprovable(
  d: Tx | ReturnType<typeof db>,
  req: typeof returnRequests.$inferSelect | undefined,
  actor: Actor & { role?: string },
) {
  if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "طلب الإرجاع غير موجود",
    });
  const inv = (await d.select().from(invoices).where(eq(invoices.id, Number(req.invoiceId))).limit(1))[0];
  if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الطلب غير موجودة",
    });
  assertReviewerAuthority(req, actor, inv.createdBy == null ? null : Number(inv.createdBy));
  const governedPending = (
    await d.select({ id: salesControlRequests.id }).from(salesControlRequests).where(and(
      eq(salesControlRequests.invoiceId, Number(req.invoiceId)),
      eq(salesControlRequests.status, "PENDING"),
    )).limit(1)
  )[0];
  if (governedPending) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `يوجد طلب تحكم حديث معلّق (#${governedPending.id}) — احسمه قبل اعتماد طلب الإرجاع القديم`,
    });
  }
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

/** سلطة المراجع مستقلة عن صلاحية لقطة التنفيذ؛ الرفض يجب أن يستطيع إغلاق طلبٍ stale. */
function assertReviewerAuthority(
  req: typeof returnRequests.$inferSelect,
  actor: Actor & { role?: string },
  invoiceCreatedBy: number | null,
) {
  if (req.status !== "PENDING_APPROVAL") {
    throw new TRPCError({ code: "CONFLICT", message: "الطلب محسومٌ سلفاً" });
  }
  if (
    actor.branchId != null &&
    actor.role !== "admin" &&
    Number(req.branchId) !== Number(actor.branchId)
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: "الطلب يخصّ فرعاً آخر" });
  }
  // فصل المهام صفةٌ للعملية لا للدور: لا admin ولا manager يعتمد/يرفض طلبه أو فاتورته.
  if (Number(req.createdBy) === Number(actor.userId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا تعتمد طلبك بنفسك — يعتمده مديرٌ آخر (فصل المهام)",
    });
  }
  if (invoiceCreatedBy != null && invoiceCreatedBy === Number(actor.userId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "منشئ الفاتورة لا يراجع طلب إرجاعها — يلزم مراجع مستقل",
    });
  }
}

/** ختمُ الاعتماد **داخل معاملة التنفيذ** — لا يُفصَل عنها (انظر `loadApprovableRequestTx`). */
export async function markRequestApprovedTx(
  tx: Tx,
  requestId: number,
  actorUserId: number,
  resultInvoiceId: number | null,
) {
  const updated = await tx
    .update(returnRequests)
    .set({
      status: "APPROVED",
      approvedBy: actorUserId,
      approvedAt: new Date(),
      resultReturnInvoiceId: resultInvoiceId,
    })
    .where(
      and(
        eq(returnRequests.id, requestId),
        eq(returnRequests.status, "PENDING_APPROVAL"),
      ),
    );
  if (extractAffectedRows(updated) !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت حالة طلب الإرجاع قبل ختم الاعتماد",
    });
  }
}

/** يختم الطلب مُعتمَداً بعد تنفيذ المرتجع فعلياً (يُستدعى من الراوتر بعد `returns.create`). */
export async function markRequestApproved(requestId: number, actorUserId: number, resultInvoiceId: number | null,
) {
  const updated = await db()
    .update(returnRequests)
    .set({
      status: "APPROVED",
      approvedBy: actorUserId,
      approvedAt: new Date(),
      resultReturnInvoiceId: resultInvoiceId,
    })
    .where(
      and(
        eq(returnRequests.id, requestId),
        eq(returnRequests.status, "PENDING_APPROVAL"),
      ),
    );
  if (extractAffectedRows(updated) !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت حالة طلب الإرجاع قبل ختم الاعتماد",
    });
  }
}

/** يرفض الطلب بسببٍ إلزاميّ — الموظّف يرى لماذا. */
export async function rejectReturnRequest(
  requestId: number,
  reason: string,
  actor: Actor & { role?: string },
) {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الرفض مطلوب — الموظّف يحتاج معرفة لماذا",
    });
  }
  return withTx(async (tx) => {
    // يجب أن يكون «تحقّق القابلية + الرفض» تحت قفل الطلب نفسه الذي يأخذه الاعتماد.
    // الفصل السابق بين SELECT وUPDATE كان يسمح لرافضٍ متأخر بأن يقلب APPROVED إلى
    // REJECTED بعد أن نفّذ المعتمد المرتجع المالي فعلاً. القفل يحسم الترتيب، والشرط
    // على الحالة يبقى حارساً أخيراً حتى لو ظهر كاتبٌ جديد لا يتبع القفل مستقبلاً.
    const request = (
      await tx
        .select()
        .from(returnRequests)
        .where(eq(returnRequests.id, requestId))
        .for("update")
        .limit(1)
    )[0];
    if (!request)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "طلب الإرجاع غير موجود",
      });
    // لا نفحص invoiceReturnedSnapshot هنا عمداً: إذا أصبح الطلب stale فرفضه هو المخرج
    // التشغيلي الصحيح لإغلاقه والسماح بطلب جديد؛ الاعتماد وحده يبقى محجوباً باللقطة.
    const invoice = (
      await tx
        .select({ createdBy: invoices.createdBy })
        .from(invoices)
        .where(eq(invoices.id, Number(request.invoiceId)))
        .limit(1)
    )[0];
    if (!invoice) {
      throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الطلب غير موجودة" });
    }
    assertReviewerAuthority(
      request,
      actor,
      invoice.createdBy == null ? null : Number(invoice.createdBy),
    );
    const rejectedAt = new Date();
    const updated = await tx
      .update(returnRequests)
    .set({
      status: "REJECTED",
      approvedBy: actor.userId,
      approvedAt: rejectedAt,
      rejectionReason: trimmed,
    })
    .where(
        and(
          eq(returnRequests.id, requestId),
          eq(returnRequests.status, "PENDING_APPROVAL"),
        ),
      );
    if (extractAffectedRows(updated) !== 1) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "تغيّرت حالة طلب الإرجاع أثناء الرفض — حدّث القائمة ولا تُعد المحاولة على حالة قديمة",
      });
    }
    return { requestId, status: "REJECTED" as const };
});
}
