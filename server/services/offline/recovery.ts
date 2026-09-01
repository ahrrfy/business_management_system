// طابور استرداد المبيعات الأوفلاينية المرفوضة — المسار و-٤ (ورقة الإصلاحات ١٦/٨).
//
// الجذر: بيعٌ نقديّ التُقط أوفلاين ووصل بعد إغلاق ورديته (أو بعد ٧٢ ساعة) يُرفض ولا يُكتب
// منه شيء، بينما **الزبون دفع والبضاعة خرجت**. رسالة الرفض نفسها تُحيل إلى «مراجعة التسوية
// اللاحقة» — ولم تكن موجودة. هنا هي.
//
// الثابت الحاكم: هذا الملفّ **لا يُنشئ أثراً مالياً**. الالتقاط تسجيلُ ادّعاءٍ لا قيد؛ والقيد
// يُكتب حصراً عند ترحيل المدير عبر `createSale` إلى وردية مفتوحة.
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { invoices, offlineRecoveryItems, shifts, users } from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { logger } from "../../logger";
import { logAuditTx } from "../auditService";
import { requireDb, withTx, type Actor } from "../tx";
import { replayOfflineSale, type ReplayOfflineSaleInput } from "./replaySale";

type AuditContext = Pick<TrpcContext, "user" | "req">;

/**
 * التقاط رفضٍ خادمياً — يُستدعى من الراوتر لحظة رفض الترحيل لسببِ أعمال.
 *
 * **صامتٌ عمداً عند الفشل:** الالتقاط خدمةُ إنقاذ، ولا يجوز أن يُحوِّل رفضاً مفهوماً إلى خطأ
 * ٥٠٠ يُربك الكاشير. وidempotent بـ`clientRequestId` (قيد فريد) لأنّ الجهاز يُعيد المحاولة
 * بطبعه ⇒ الطابور يعكس عدد العمليات لا عدد المحاولات.
 */
export async function captureRejectedReplay(
  input: ReplayOfflineSaleInput,
  rejectCode: string,
  rejectReason: string,
  submittedByUserId: number,
  channel: "RETAIL" | "PRINT" | "RECEPTION" | "RETURN" = "RETAIL",
): Promise<void> {
  try {
    const db = requireDb();
    await db
      .insert(offlineRecoveryItems)
      .values({
        branchId: input.branchId,
        deviceId: input.deviceId ?? null,
        clientRequestId: input.clientRequestId,
        offlineReceiptNumber: input.offlineReceiptNumber,
        capturedAt: new Date(input.capturedAt),
        payload: JSON.stringify(input),
        rejectCode,
        rejectReason,
        submittedByUserId,
        channel,
      })
      .onDuplicateKeyUpdate({ set: { rejectCode, rejectReason, submittedByUserId } });
  } catch (e) {
    // فشل الالتقاط لا يُغيّر نتيجة الترحيل ولا يجوز أن يحجب رسالة الرفض عن المستخدم —
    // **لكنّه لا يُبتلَع صامتاً**: صمتٌ هنا يعني بيعاً مدفوعاً يضيع بلا أثر، وهو العطل نفسه
    // الذي جاءت هذه الشريحة لتغلقه. يُسجَّل بمستوى error كي يظهر في مراقبة الإنتاج.
    logger.error(
      {
        err: e instanceof Error ? { message: e.message } : e,
        offlineReceiptNumber: input.offlineReceiptNumber,
        branchId: input.branchId,
      },
      "offline.recovery: تعذّر التقاط بيعٍ أوفلاينيّ مرفوض — خطر ضياع نقد",
    );
  }
}

export interface RecoveryQueueRow {
  id: number;
  branchId: number;
  offlineReceiptNumber: string;
  capturedAt: Date;
  amount: string;
  lineCount: number;
  deviceId: string | null;
  rejectCode: string;
  rejectReason: string | null;
  ageDays: number;
  channel: "RETAIL" | "PRINT" | "RECEPTION" | "RETURN";
  /** الترحيل الآليّ لبيع التجزئة وحده؛ البقيّة تُعرَض للرصد وتُسوَّى يدوياً. */
  postable: boolean;
}

/** الطابور المعلَّق في نطاق المدير — admin يعبُر الفروع، وغيره فرعه وحده. */
export async function listRecoveryQueue(actor: Actor): Promise<RecoveryQueueRow[]> {
  const elevated = actor.role === "admin";
  const rows = await requireDb()
    .select()
    .from(offlineRecoveryItems)
    .where(
      and(
        eq(offlineRecoveryItems.recoveryStatus, "PENDING"),
        ...(elevated ? [] : [eq(offlineRecoveryItems.branchId, actor.branchId)]),
      ),
    )
    .orderBy(asc(offlineRecoveryItems.capturedAt));

  const now = Date.now();
  return rows.map((r) => {
    let amount = "0";
    let lineCount = 0;
    try {
      const p = JSON.parse(r.payload) as ReplayOfflineSaleInput;
      amount = p.payment?.amount ?? "0";
      lineCount = p.lines?.length ?? 0;
    } catch {
      // حمولةٌ تالفة تبقى مرئيّةً بأرقام صفرية — إخفاؤها أسوأ من عرضها ناقصة.
    }
    const captured = r.capturedAt instanceof Date ? r.capturedAt.getTime() : new Date(r.capturedAt).getTime();
    return {
      id: Number(r.id),
      branchId: Number(r.branchId),
      offlineReceiptNumber: r.offlineReceiptNumber,
      capturedAt: r.capturedAt,
      amount,
      lineCount,
      deviceId: r.deviceId,
      rejectCode: r.rejectCode,
      rejectReason: r.rejectReason,
      ageDays: Math.max(0, Math.floor((now - captured) / 86_400_000)),
      channel: r.channel,
      postable: r.channel === "RETAIL",
    };
  });
}

/**
 * ترحيل عنصرٍ محتجَز إلى وردية **مفتوحة** بقرار المدير.
 *
 * يُعاد استعمال `replayOfflineSale` نفسها (لا مسار بيعٍ موازٍ) مع تجاوز حارس عمر الالتقاط —
 * لأنّ العمر هو **سبب** وجود العنصر هنا، وقد راجعه إنسانٌ الآن. أمّا حارس الوردية المفتوحة
 * فيبقى نافذاً: الإقفال حدٌّ محاسبيّ لا يُكتب بأثر رجعيّ، ولذلك يختار المدير ورديةً جارية.
 * الرقم الأوفلاينيّ المطبوع للزبون يُحمَل كما هو ⇒ يبقى الإيصال الورقيّ مربوطاً بالفاتورة.
 */
export async function postRecoveryItem(
  id: number,
  targetShiftId: number,
  actor: Actor,
  auditCtx?: AuditContext,
): Promise<{ recoveryItemId: number; invoiceId: number; offlineReceiptNumber: string }> {
  const db = requireDb();
  const item = (await db.select().from(offlineRecoveryItems).where(eq(offlineRecoveryItems.id, id)).limit(1))[0];
  if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "العنصر غير موجود في طابور الاسترداد" });
  if (item.recoveryStatus !== "PENDING") {
    throw new TRPCError({ code: "CONFLICT", message: "العنصر رُحِّل أو أُهمل سابقاً" });
  }
  if (actor.role !== "admin" && Number(item.branchId) !== Number(actor.branchId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "العنصر لا يخصّ فرعك" });
  }

  const shift = (await db.select().from(shifts).where(eq(shifts.id, targetShiftId)).limit(1))[0];
  if (!shift || Number(shift.branchId) !== Number(item.branchId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "الوردية الهدف لا تخصّ فرع العنصر" });
  }
  if (shift.status !== "OPEN") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "اختر ورديةً مفتوحة — لا يُكتب في وردية مقفلة" });
  }

  if (item.channel !== "RETAIL") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "الترحيل الآليّ متاحٌ لبيع التجزئة؛ عمليات الطباعة/الاستقبال مُسجَّلة هنا للرصد وتُسوَّى يدوياً",
    });
  }
  if (shift.shiftType !== "RETAIL") {
    // بيعُ تجزئةٍ يُرحَّل إلى درج استقبالٍ أو طباعة يُفسد «النقد المتوقَّع» لذلك الدرج وZ-report
    // الخاصّ بنوعه. الشاشة تُصفّي أيضاً — والحدّ هو الحاجز.
    throw new TRPCError({ code: "BAD_REQUEST", message: "وردية التجزئة وحدها تقبل ترحيل بيعٍ أوفلاينيّ" });
  }

  // **حجزٌ ذرّيّ قبل الترحيل**: قراءةٌ غير مقفولة ثمّ تحديثٌ لاحق كانت تسمح لمديرَين بترحيل
  // ورفض العنصر نفسه معاً (أحدهما يكتب فاتورةً والآخر يُعلنه مُهمَلاً). الانتقال PENDING→POSTED
  // شرطٌ في الـWHERE ⇒ الفائز واحد، والخاسر يرى CONFLICT.
  const claim = await db
    .update(offlineRecoveryItems)
    .set({ recoveryStatus: "POSTED", reviewedBy: actor.userId, reviewedAt: new Date() })
    .where(and(eq(offlineRecoveryItems.id, id), eq(offlineRecoveryItems.recoveryStatus, "PENDING")));
  const claimed = Number((claim as unknown as { affectedRows?: number })?.affectedRows ?? (claim as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0);
  if (claimed < 1) {
    throw new TRPCError({ code: "CONFLICT", message: "العنصر رُحِّل أو أُهمل سابقاً" });
  }

  const payload = JSON.parse(item.payload) as ReplayOfflineSaleInput;
  let result: Awaited<ReturnType<typeof replayOfflineSale>>;
  try {
    result = await replayOfflineSale(
      {
        ...payload,
        branchId: Number(item.branchId),
        shiftId: targetShiftId,
        // ⚠️ **المفتاح الأصليّ كما هو** — لا مفتاحاً جديداً. سببان:
        // (١) الازدواج: قد يكون الترحيل الأوّل التزم فعلاً وضاع ردّه، فوصل الجهاز بعد ٧٢ ساعة
        //     فرُفض قبل أن يبلغ فحص idempotency ⇒ التقطناه. الترحيل بمفتاحٍ جديد كان **يُنشئ
        //     فاتورةً وإيصالاً وقيداً وحركة مخزونٍ ثانية للبيع الماديّ نفسه**. بالمفتاح الأصليّ
        //     يربط `createSale` الفاتورة القائمة بدل تكرارها.
        // (٢) الطول: `invoices.sourceId` = varchar(50)، والمفتاح المركَّب كان يتجاوزه فيفشل
        //     الإدراج ويبقى بيعٌ قابلٌ للاسترداد معلّقاً أبداً.
        clientRequestId: payload.clientRequestId,
        priceOverrideApproved: true,
      },
      actor,
      {
        skipCaptureWindow: true,
        attributeToUserId: item.submittedByUserId ?? actor.userId,
      },
    );
  } catch (e) {
    // فشل الترحيل يُعيد العنصر إلى الطابور — وإلّا بقي «مُرحَّلاً» بلا فاتورة.
    await db
      .update(offlineRecoveryItems)
      .set({ recoveryStatus: "PENDING", reviewedBy: null, reviewedAt: null })
      .where(eq(offlineRecoveryItems.id, id));
    throw e;
  }

  await db
    .update(offlineRecoveryItems)
    .set({ invoiceId: result.invoiceId })
    .where(eq(offlineRecoveryItems.id, id));

  // **نسبة البيع لبائعه**: `createSale` يكتب الفاعل (المدير المُراجِع) في `invoices.createdBy`
  // و`salespersonNameSnapshot`، ومحرّك العمولات ينسب الفاتورة بـ`createdBy`
  // (`commissions/base.ts`) ⇒ كانت كلّ عملية استرداد تُحوّل عمولة الكاشير إلى المدير وتُفسد
  // تقارير البائعين. نُعيد النسبة إلى مُلتقِط البيع الأصليّ، والمُراجِع محفوظٌ في أثر التدقيق.
  if (item.submittedByUserId != null && Number(item.submittedByUserId) !== actor.userId) {
    const seller = (
      await db.select({ name: users.name }).from(users).where(eq(users.id, Number(item.submittedByUserId))).limit(1)
    )[0];
    await db
      .update(invoices)
      .set({
        createdBy: Number(item.submittedByUserId),
        ...(seller?.name ? { salespersonNameSnapshot: seller.name } : {}),
      })
      .where(eq(invoices.id, result.invoiceId));
  }

  if (auditCtx) {
    await withTx(async (tx) => {
      await logAuditTx(tx, auditCtx, {
        action: "offline.recovery.post",
        entityType: "invoice",
        entityId: result.invoiceId,
        oldValue: { recoveryItemId: Number(item.id), offlineReceiptNumber: item.offlineReceiptNumber, rejectCode: item.rejectCode },
        newValue: { invoiceId: result.invoiceId, targetShiftId, branchId: Number(item.branchId) },
      });
    });
  }

  // بيعٌ قديم/بوردية مقفلة قد يكون أيضاً تحت التكلفة أو فوق عتبة الخصم اليدويّ. المسارات
  // الأخرى تُصدر `sale.priceOverride` وشاشة التدقيق تُصنّف هذا الفعل بعينه ⇒ بدونه تختفي
  // تجاوزات الاسترداد من مراجعة التسعير.
  if (result.priceOverride && auditCtx) {
    await withTx(async (tx) => {
      await logAuditTx(tx, auditCtx, {
        action: "sale.priceOverride",
        entityType: "invoice",
        entityId: result.invoiceId,
        newValue: { approvedByUserId: actor.userId, byRole: actor.role ?? null, offlineRecovery: true },
      });
    });
  }

  return {
    recoveryItemId: Number(item.id),
    invoiceId: result.invoiceId,
    offlineReceiptNumber: item.offlineReceiptNumber,
  };
}

/** إهمال عنصرٍ محتجَز (إيصال فحصٍ/تجربة) — **بسببٍ إلزاميّ وأثرٍ تدقيقيّ**: إسقاط بيعٍ مدفوع قرارٌ يُنسَب. */
export async function discardRecoveryItem(
  id: number,
  reason: string,
  actor: Actor,
  auditCtx?: AuditContext,
): Promise<{ recoveryItemId: number }> {
  const trimmed = reason.trim();
  if (trimmed.length < 5) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الإهمال إلزاميّ (٥ أحرف على الأقل)" });
  }
  return withTx(async (tx) => {
    const item = (
      await tx.select().from(offlineRecoveryItems).where(eq(offlineRecoveryItems.id, id)).for("update").limit(1)
    )[0];
    if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "العنصر غير موجود" });
    if (item.recoveryStatus !== "PENDING") {
      throw new TRPCError({ code: "CONFLICT", message: "العنصر رُحِّل أو أُهمل سابقاً" });
    }
    if (actor.role !== "admin" && Number(item.branchId) !== Number(actor.branchId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "العنصر لا يخصّ فرعك" });
    }
    await tx
      .update(offlineRecoveryItems)
      .set({ recoveryStatus: "DISCARDED", discardReason: trimmed, reviewedBy: actor.userId, reviewedAt: new Date() })
      .where(eq(offlineRecoveryItems.id, id));

    if (auditCtx) {
      await logAuditTx(tx, auditCtx, {
        action: "offline.recovery.discard",
        entityType: "offlineRecoveryItem",
        entityId: id,
        oldValue: { offlineReceiptNumber: item.offlineReceiptNumber, amountPayload: item.payload.slice(0, 200) },
        newValue: { reason: trimmed, byUserId: actor.userId },
      });
    }
    return { recoveryItemId: id };
  });
}

/** يُستعمل في الاختبارات/الأدوات فقط. */
export { users as _usersTableRef };
