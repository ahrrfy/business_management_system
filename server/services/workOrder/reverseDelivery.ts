/**
 * **استرجاعُ أمر شغلٍ مُسلَّم** — إغلاقُ الثقب الأسود (٢٠/٨).
 *
 * أمرُ شغلٍ **خدميّ خالص** (`baseVariantId = NULL`) بعد التسليم كان **بلا مخرجٍ إطلاقاً**،
 * وكلُّ بابٍ يُحيل إلى آخرَ مغلق:
 *
 *  · `workOrders.cancel`      ⇒ «لا يمكن إلغاء أمر مُسلَّم» ([cancel.ts](./cancel.ts))
 *  · `sales.cancel`           ⇒ «لا تُلغى فواتير أوامر الشغل من هنا — استعمل مسار الأمر»
 *  · `sales.reissue/correct`  ⇒ منشأ WORKORDER مرفوض
 *  · `returns.create`         ⇒ يشترط سطراً واحداً على الأقلّ، **والفاتورة بلا بنود**
 *    (`deliver.ts`: «أمر خدمة خالص… الفاتورة بلا سطر مخزون») ⇒ لا شيء يُختار أصلاً.
 *
 * فزبونٌ رفض تصميماً سُلِّم له، أو مندوبٌ أعاد الطلب بعد ختم التسليم — تبقى الفاتورة وقيدُ
 * البيع والذمّة **حيّةً للأبد**. وهو «حدثٌ يوميّ» بنصّ المالك.
 *
 * **قاعدةُ عدم التكرار:** الفاتورةُ **ذاتُ البنود** تُفوَّض كاملةً إلى `returnSaleInTx`
 * المختبَر — لا يُنسخ منطقُه هنا. وهذا الملفّ يعالج **الحالة المسدودة وحدها**: عكسُ رأسٍ
 * موثَّقٌ لفاتورةٍ بلا بنود.
 *
 * ⛔ **ولا حالةَ `REVERSED` جديدة**: كلُّ قارئٍ لـ`workOrderStatus` سيصير أعمى عنها (تسعةُ
 * قواميس كانت منجرفة — درس [`shared/workOrderStatus.ts`](../../../shared/workOrderStatus.ts))،
 * و`reopen` يُغني عنها عملياً: إمّا يعود الأمرُ للطابور لإعادة تسليمٍ مصحَّح، أو يُغلَق ملغىً.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, notLike, or } from "drizzle-orm";
import { invoiceItems, invoices, receipts, shifts, workOrders } from "../../../drizzle/schema";
import { DEAD_INVOICE_STATUSES } from "@shared/invoiceStatus";
import { extractInsertId } from "../../lib/insertId";
import { adjustCustomerBalance, postEntry } from "../ledgerService";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { money, round2, toDbMoney } from "../money";
import { assertCashOutAvailable, assertNonPhysicalOutReceipt } from "../cash/cashAvailability";
import { paymentAssetRole } from "../sale/paymentPosting";
import { checkIdempotency, idempotencyHash, recordIdempotencyKey } from "../idempotency";
import { logAuditTx } from "../auditService";
import { returnSaleInTx } from "../returnService";
import { type Actor, withTx } from "../tx";
import { assertNoLiveConsignment, assertWorkOrderBranch, loadWorkOrder } from "./helpers";

/**
 * `logAuditTx` يطلب `ctx` كاملاً بينما الخدمة **لا تقرأ `ctx`** (قاعدة الطبقات §٢) — تستقبل
 * `Actor` وحده. فنبني أضيقَ شكلٍ يقبله: الفاعلُ صادقٌ، وحقولُ الطلب (IP/UA) غائبةٌ صراحةً
 * لأنّ الخدمةَ لا تملكها ولا يصحّ أن تختلقها.
 */
const auditCtx = (actor: Actor) =>
  ({ user: { id: actor.userId, branchId: actor.branchId }, req: undefined }) as unknown as Parameters<typeof logAuditTx>[1];

export interface ReverseWorkOrderDeliveryInput {
  workOrderId: number;
  /** سببٌ إلزاميّ — يُكتب على المستند (0237) فيصير قابلاً للقراءة والتقرير. */
  reason: string;
  /** `true` ⇒ يعود الأمر `READY` لإعادة تسليمٍ مصحَّح. `false`/غيابه ⇒ يُغلَق `CANCELLED`. */
  reopen?: boolean;
  /** درجُ الاسترداد النقديّ — يُلزَم فقط حين تتعدّد ورديات RECEPTION المفتوحة. */
  refundShiftId?: number | null;
  clientRequestId?: string | null;
}

/** درجُ استقبالٍ مفتوحٌ مقفلٌ للاسترداد النقديّ — نفس منطق [cancel.ts](./cancel.ts) حرفياً. */
async function resolveLockedReceptionCashShift(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  branchId: number,
  explicitShiftId: number | null,
): Promise<number> {
  const open = await tx
    .select({ id: shifts.id })
    .from(shifts)
    .where(and(eq(shifts.branchId, branchId), eq(shifts.status, "OPEN"), eq(shifts.shiftType, "RECEPTION")));
  const chosen = explicitShiftId != null
    ? open.find((row) => Number(row.id) === explicitShiftId)
    : open.length === 1
      ? open[0]
      : null;
  if (!chosen) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: open.length > 1
        ? "توجد عدة ورديات RECEPTION مفتوحة؛ حدّد درج الاسترداد النقدي صراحةً"
        : "لا توجد وردية RECEPTION مفتوحة لهذا الاسترداد النقدي",
    });
  }
  const locked = (
    await tx
      .select({ id: shifts.id, status: shifts.status, shiftType: shifts.shiftType })
      .from(shifts)
      .where(eq(shifts.id, Number(chosen.id)))
      .for("update")
      .limit(1)
  )[0];
  if (!locked || locked.status !== "OPEN" || locked.shiftType !== "RECEPTION") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "وردية RECEPTION المستهدفة أُغلقت؛ أعد المحاولة" });
  }
  return Number(locked.id);
}

export async function reverseWorkOrderDelivery(
  input: ReverseWorkOrderDeliveryInput,
  actor: Actor & { role?: string },
) {
  return withTx(async (tx) => {
    const workOrderId = Number(input.workOrderId);
    const reason = input.reason.trim();
    if (reason.length < 3) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "سبب الاسترجاع مطلوب (٣ أحرف على الأقل)" });
    }

    const clientRequestId = input.clientRequestId?.trim() || null;
    const fingerprint = clientRequestId
      ? idempotencyHash({ workOrderId, reopen: input.reopen === true, refundShiftId: input.refundShiftId ?? null })
      : null;
    if (clientRequestId) {
      const existingId = await checkIdempotency(tx, "workOrder.reverseDelivery", clientRequestId, fingerprint, {
        requireStoredHash: true,
      });
      if (existingId != null) {
        if (existingId !== workOrderId) {
          throw new TRPCError({ code: "CONFLICT", message: "معرّف الاسترجاع مرتبط بطلب آخر" });
        }
        return { workOrderId, replayed: true as const, delegatedToReturn: false, pendingRefundReceiptIds: [] as number[] };
      }
    }

    const wo = await loadWorkOrder(tx, workOrderId);
    assertWorkOrderBranch(wo, actor);
    if (wo.status !== "DELIVERED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "الاسترجاع لأمرٍ مُسلَّم فقط — الأمرُ الذي لم يُسلَّم يُلغى من مسار الإلغاء",
      });
    }
    if (wo.invoiceId == null) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "لا فاتورة لهذا الأمر — لا شيء يُعكَس" });
    }
    // الطردُ بيد المندوب: عكسُ البيع الآن يُسقط الذمّة بينما العهدة والتحصيل قائمان.
    await assertNoLiveConsignment(tx, workOrderId, "reverse");

    const inv = (
      await tx.select().from(invoices).where(eq(invoices.id, Number(wo.invoiceId))).for("update").limit(1)
    )[0];
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "فاتورة الأمر غير موجودة" });
    if ((DEAD_INVOICE_STATUSES as readonly string[]).includes(String(inv.status))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "الفاتورة ملغاة أو مرتجعة أو مستبدلة سلفاً" });
    }

    const items = await tx
      .select({ id: invoiceItems.id, baseQuantity: invoiceItems.baseQuantity })
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, Number(inv.id)));

    // ── المسار (أ): فاتورةٌ ذاتُ بنود ⇒ تفويضٌ كامل للمسار المختبَر ────────────────────
    // ⛔ لا يُنسخ منطقُ المرتجع هنا: نسخةٌ ثانيةٌ تنجرف عن الأصل حتماً، وقد يمسّ الانجرافُ
    // مالاً. و`restock` يبقى `false` لأنّ الخامة استُهلكت ولا تعود صنفاً صالحاً على الرفّ.
    if (items.length > 0) {
      const res = await returnSaleInTx(
        tx,
        {
          invoiceId: Number(inv.id),
          lines: items.map((it) => ({ invoiceItemId: Number(it.id), baseQuantity: Number(it.baseQuantity) })),
          restock: false,
          clientRequestId: clientRequestId ? `${clientRequestId}:ret` : null,
        },
        actor,
      );
      await tx.update(workOrders).set({
        status: input.reopen === true ? "READY" : "CANCELLED",
        cancelReason: reason,
        cancelledAt: new Date(),
        cancelledBy: actor.userId,
        ...(input.reopen === true ? { invoiceId: null, deliveredAt: null } : {}),
      }).where(eq(workOrders.id, workOrderId));
      await logAuditTx(tx, auditCtx(actor), {
        action: "workOrder.reverseDelivery",
        entityType: "workOrder",
        entityId: workOrderId,
        newValue: { reason, reopen: input.reopen === true, delegatedToReturn: true, invoiceId: Number(inv.id) },
      });
      if (clientRequestId) {
        await recordIdempotencyKey(tx, "workOrder.reverseDelivery", clientRequestId, workOrderId, fingerprint);
      }
      return { workOrderId, replayed: false as const, delegatedToReturn: true, pendingRefundReceiptIds: [] as number[], ...res };
    }

    // ── المسار (ب): فاتورةٌ بلا بنود — الحالةُ المسدودة ───────────────────────────────
    const salePrice = round2(money(inv.total ?? "0"));
    const materialsCost = round2(money(wo.materialsCost ?? "0"));
    const paid = round2(money(inv.paidAmount ?? "0"));
    // العربونُ المُقفَل ضمن قيد البيع = ما دخل `paidAmount` عبر إيصالات ما قبل التسليم.
    // نُعيد فتحه بالقدر نفسه فيبقى `Σ(قيود الاحتجاز) = 0` عند إبرائه بالردّ (§٥).
    const depositClosed = round2(money(wo.deposit ?? "0"));
    const depositPaid = depositClosed.gt(paid) ? paid : depositClosed;
    const unpaid = round2(salePrice.minus(paid));

    // مرآةُ `SALE_SERVICE_FLEX` دوراً بدور — كلُّ سطرٍ في البيع له نقيضُه هنا.
    const roleDebits: Record<string, ReturnType<typeof money>> = { SALES_FLEX: salePrice };
    const roleCredits: Record<string, ReturnType<typeof money>> = { AR: salePrice };
    const lines = [debitLine("SALES_FLEX", salePrice), creditLine("AR", salePrice)];
    if (materialsCost.gt(0)) {
      lines.push(debitLine("WORK_IN_PROGRESS", materialsCost), creditLine("COGS", materialsCost));
      roleDebits.WORK_IN_PROGRESS = materialsCost;
      roleCredits.COGS = materialsCost;
    }
    if (depositPaid.gt(0)) {
      // إعادةُ فتح الأمانة: المالُ عاد مالَ الزبون بعد سقوط البيع.
      lines.push(debitLine("AR", depositPaid), creditLine("OTHER_LIABILITY", depositPaid));
      roleDebits.AR = depositPaid;
      roleCredits.OTHER_LIABILITY = depositPaid;
    }
    const components = { roleDebits, roleCredits };
    await postEntry(tx, {
      entryType: "RETURN",
      dedupeKey: `WO-REVERSE:${workOrderId}`,
      branchId: Number(wo.branchId),
      invoiceId: Number(inv.id),
      customerId: wo.customerId ?? null,
      // RETURN بقيمٍ سالبة (§٥) — التقارير تطرحه بلا فرعٍ خاص.
      revenue: salePrice.neg(),
      cost: materialsCost.neg(),
      profit: round2(salePrice.minus(materialsCost)).neg(),
      amount: salePrice.neg(),
      notes: `استرجاع تسليم أمر الشغل ${wo.orderNumber} — ${reason}`,
      postingIntent: createPostingIntent("RETURN_SALE_FLEX_WORKORDER", "RETURN", lines, components),
      postingSourceComponents: components,
    });

    // الذمّة: يسقط ما لم يُسدَّد فقط. المسدَّدُ يُعالَج بالردّ أدناه — لا يُخصم مرّتين.
    if (wo.customerId && unpaid.gt(0)) {
      await adjustCustomerBalance(tx, Number(wo.customerId), unpaid.neg());
    }

    // ── الردّ الفعليّ لما قُبض ───────────────────────────────────────────────────────
    // ⛔ ثابتُ #638: لا يُحفَظ عكسٌ يُبقي في المكتبة مالاً هو للعميل. كلُّ إيصال IN مكتملٍ
    // على هذه الفاتورة/الأمر يُقابَل بـOUT بطريقة قبضه (وTELECOM يُردّ نقداً — لا سكّةَ رجوعٍ له).
    const pendingRefundReceiptIds: number[] = [];
    if (paid.gt(0)) {
      const inRows = await tx
        .select({
          id: receipts.id,
          amount: receipts.amount,
          paymentMethod: receipts.paymentMethod,
        })
        .from(receipts)
        .where(and(
          or(eq(receipts.invoiceId, Number(inv.id)), eq(receipts.workOrderId, workOrderId)),
          eq(receipts.direction, "IN"),
          eq(receipts.status, "COMPLETED"),
          eq(receipts.approvalStatus, "APPROVED"),
          // أمانةُ أجرة التوصيل ليست ثمنَ الطلب — لها مسارُ ردٍّ خاصّ في الإلغاء.
          or(isNull(receipts.referenceNumber), notLike(receipts.referenceNumber, "DLV-FEE-%")),
        ))
        .for("update");

      // ⚠️ **تخصيصٌ حتميّ**: إيصالُ العربون أوّلاً كي لا يتغيّر توزيعُ الأدوار بترتيب القاعدة.
      const depositReceiptId = wo.depositReceiptId != null ? Number(wo.depositReceiptId) : 0;
      inRows.sort((a, b) => {
        const ra = Number(a.id) === depositReceiptId ? 0 : 1;
        const rb = Number(b.id) === depositReceiptId ? 0 : 1;
        return ra - rb || Number(a.id) - Number(b.id);
      });

      /**
       * **الحسابُ الذي يُبرئه الردّ يتبع ما سدّده القبضُ أصلاً** (تصويب مراجعة Codex، ٢٠/٨):
       *
       *  · **عربونٌ قُبض قبل التسليم** ⇒ كان محتجَزاً في `OTHER_LIABILITY`، وقيدُ البيع أقفله.
       *    فالعكسُ يُعيد فتحه (أعلاه) والردُّ يُبرئه ⇒ الخصمُ على `OTHER_LIABILITY`.
       *  · **دفعةٌ قُبضت عند التسليم أو بعده** ⇒ لم تمرّ بالأمانة قطّ: قيدُها
       *    `PAYMENT_IN` سدّد **`AR`** مباشرةً. فالخصمُ عليها لا على الأمانة.
       *
       * وكان الكودُ يخصم `OTHER_LIABILITY` لكلّ إيصالٍ مردود بينما يُعيد فتح **العربون وحده**:
       * أمرٌ بعربون ٢٠٬٠٠٠ ودفعةِ تسليمٍ ٨٠٬٠٠٠ يفتح ٢٠٬٠٠٠ ويخصم ١٠٠٬٠٠٠ ⇒ **أمانةٌ سالبة
       * بـ٨٠٬٠٠٠** ودفترٌ لا يوافق `customers.currentBalance`. (جولتي البصريّة أنتجت هذا
       * بالضبط ولم ألحظه: تحقّقتُ من `amount/revenue` لا من مكوّنات الأدوار.)
       */
      let liabilityLeft = depositPaid;

      let cashShiftId: number | null = null;
      for (const r of inRows) {
        const amt = round2(money(r.amount));
        if (amt.lte(0)) continue;
        const liabilityPart = liabilityLeft.gte(amt) ? amt : liabilityLeft;
        const arPart = round2(amt.minus(liabilityPart));
        liabilityLeft = round2(liabilityLeft.minus(liabilityPart));
        const collected = r.paymentMethod ?? "CASH";
        const refundMethod = collected === "TELECOM" ? "CASH" : collected;
        let shiftId: number | null = null;
        if (refundMethod === "CASH") {
          cashShiftId ??= await resolveLockedReceptionCashShift(tx, Number(wo.branchId), input.refundShiftId ?? null);
          shiftId = cashShiftId;
          await assertCashOutAvailable(tx, {
            branchId: Number(wo.branchId), cashBucket: "DRAWER", shiftId,
            amount: amt, operation: "ردّ مقبوضات استرجاع أمر الشغل",
          });
        } else {
          if (wo.customerId == null) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "الردّ غير النقديّ يحتاج عميلاً مرتبطاً كي يمرّ بسند واعتماد مالك",
            });
          }
          // إيصالٌ واحدٌ يقع نصفُه أمانةً ونصفُه ذمّةً: حالةٌ مرضيّة (تعني أنّ `paidAmount`
          // أقلّ من عربون الأمر) ولا يسع نوعٌ واحدٌ في الملاحظة تمثيلَ قيمتَين. **نفشل
          // مغلقين** بدل تخمين أحد الحسابين وتسميم الدفتر بصمت.
          if (liabilityPart.gt(0) && arPart.gt(0)) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `إيصال القبض #${Number(r.id)} موزّعٌ بين أمانة العربون وذمّة العميل — لا يُردّ آلياً بطريقةٍ غير نقدية؛ راجع الإيصالات`,
            });
          }
          assertNonPhysicalOutReceipt({
            classification: "DEFERRED_APPROVAL",
            paymentMethod: refundMethod,
            cashBucket: null,
            approvalStatus: "PENDING_APPROVAL",
            operation: "طلب ردّ غير نقديّ لاسترجاع أمر شغل",
          });
        }
        const insRes = await tx.insert(receipts).values({
          branchId: Number(wo.branchId),
          shiftId,
          workOrderId,
          invoiceId: Number(inv.id),
          direction: "OUT",
          amount: toDbMoney(amt),
          paymentMethod: refundMethod,
          cashBucket: refundMethod === "CASH" ? "DRAWER" : null,
          status: refundMethod === "CASH" ? "COMPLETED" : "PENDING",
          approvalStatus: refundMethod === "CASH" ? "APPROVED" : "PENDING_APPROVAL",
          referenceNumber: refundMethod === "CASH" ? `WO-REVERSE-REFUND-${workOrderId}` : null,
          description: refundMethod === "CASH"
            ? `ردّ مقبوض — استرجاع تسليم أمر الشغل ${wo.orderNumber}`
            : `طلب ردّ غير نقديّ معلّق — استرجاع تسليم أمر الشغل ${wo.orderNumber}`,
          partyType: wo.customerId ? "CUSTOMER" : "OTHER",
          partyId: wo.customerId ?? null,
          // النوعُ يحمل **الحسابَ المقابل** كي يستعمله مسارُ الاعتماد المؤجَّل نفسَه
          // بلا إعادة اشتقاق (وإلّا خصم الأمانةَ لدفعةٍ سدّدت الذمّة).
          internalNote: refundMethod !== "CASH"
            ? `WORK_ORDER_CUSTOMER_REFUND:${liabilityPart.gt(0) ? "REVERSE_LIABILITY" : "REVERSE_AR"}:${workOrderId}:${Number(r.id)}`
            : null,
          createdBy: actor.userId,
        });
        const refundReceiptId = extractInsertId(insRes);
        if (refundMethod !== "CASH") pendingRefundReceiptIds.push(refundReceiptId);
        if (refundMethod === "CASH") {
          const assetRole = paymentAssetRole(refundMethod, "DRAWER", "OUT");
          const note = `ردّ مقبوض — استرجاع تسليم أمر الشغل ${wo.orderNumber}${collected === "TELECOM" ? " (أصل القبض: رصيد زين — رُدّ نقداً)" : ""}`;
          // شقّان مستقلّان بقيدَين: `PAYMENT_OUT_OTHER` لا يقبل `AR` مديناً و
          // `PAYMENT_OUT_CUSTOMER_REFUND` لا يقبل `OTHER_LIABILITY` — والفصلُ يُبقي كلَّ
          // قيدٍ مطابقاً لسياسة profile الخاصّة به بدل توسيعِ إحداهما لتبتلع الأخرى.
          if (liabilityPart.gt(0)) {
            // الأمانةُ التي أُعيد فتحها أعلاه تُبرَّأ الآن بخروج النقد ⇒ Σ(قيود الاحتجاز) = 0 (§٥).
            const src = { roleDebits: { OTHER_LIABILITY: liabilityPart }, roleCredits: { [assetRole]: liabilityPart } };
            await postEntry(tx, {
              entryType: "PAYMENT_OUT",
              branchId: Number(wo.branchId),
              receiptId: refundReceiptId,
              customerId: wo.customerId ?? null,
              amount: liabilityPart,
              notes: `${note} — حصّة العربون`,
              postingIntent: createPostingIntent("PAYMENT_OUT_OTHER", "PAYMENT_OUT", [debitLine("OTHER_LIABILITY", liabilityPart), creditLine(assetRole, liabilityPart)], src),
              postingSourceComponents: src,
            });
          }
          if (arPart.gt(0)) {
            // دفعةُ التسليم سدّدت `AR` مباشرةً ⇒ ردُّها يُعيد الذمّة قبل أن يُسقطها عكسُ البيع.
            const src = { roleDebits: { AR: arPart }, roleCredits: { [assetRole]: arPart } };
            await postEntry(tx, {
              entryType: "PAYMENT_OUT",
              branchId: Number(wo.branchId),
              receiptId: refundReceiptId,
              customerId: wo.customerId ?? null,
              amount: arPart,
              notes: `${note} — حصّة دفعة التسليم`,
              postingIntent: createPostingIntent("PAYMENT_OUT_CUSTOMER_REFUND", "PAYMENT_OUT", [debitLine("AR", arPart), creditLine(assetRole, arPart)], src),
              postingSourceComponents: src,
            });
          }
        }
      }
    }

    await tx.update(invoices).set({
      status: "RETURNED",
      returnedTotal: toDbMoney(salePrice),
    }).where(eq(invoices.id, Number(inv.id)));

    await tx.update(workOrders).set({
      status: input.reopen === true ? "READY" : "CANCELLED",
      cancelReason: reason,
      cancelledAt: new Date(),
      cancelledBy: actor.userId,
      // إعادةُ الفتح تفكّ ارتباط الفاتورة المرتجعة: بلا هذا يصطدم التسليمُ الثاني بقيد
      // `uq_wo_invoice` الفريد فيتعذّر إعادةُ التسليم أصلاً — وهي الغاية من `reopen`.
      ...(input.reopen === true ? { invoiceId: null, deliveredAt: null } : {}),
    }).where(eq(workOrders.id, workOrderId));

    await logAuditTx(tx, auditCtx(actor), {
      action: "workOrder.reverseDelivery",
      entityType: "workOrder",
      entityId: workOrderId,
      oldValue: { status: "DELIVERED", invoiceId: Number(inv.id), paidAmount: paid.toFixed(2) },
      newValue: {
        reason, reopen: input.reopen === true, delegatedToReturn: false,
        reversedTotal: salePrice.toFixed(2), refundedTotal: paid.toFixed(2),
      },
    });

    if (clientRequestId) {
      await recordIdempotencyKey(tx, "workOrder.reverseDelivery", clientRequestId, workOrderId, fingerprint);
    }

    return {
      workOrderId,
      replayed: false as const,
      delegatedToReturn: false,
      invoiceId: Number(inv.id),
      reversedTotal: salePrice.toFixed(2),
      refundedTotal: paid.toFixed(2),
      pendingRefundReceiptIds,
      status: input.reopen === true ? ("READY" as const) : ("CANCELLED" as const),
    };
  });
}

