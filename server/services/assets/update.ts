// تعديل بيانات أصل قائم (لا يشمل العهدة/الحالة/الاستبعاد — لها مساراتها).
import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { accountingEntries, employees, fixedAssets, kioskDevices, receipts } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { adjustSupplierBalance, postEntry } from "../ledgerService";
import { money, toDbMoney } from "../money";
import { type Actor, withTx } from "../tx";
import { companyBranchScope, resolveTargetBranch } from "../companyBranchScope";
import { computeDepreciation } from "./depreciation";
import { loadForUpdate } from "./helpers";
import { getAsset } from "./queries";
import { createSystemPaymentRequestTx, parseSystemPaymentRequest } from "../voucher/create";
import { lockCashSourceForUpdate } from "../cash/cashAvailability";

/** تعديل بيانات أصل قائم (لا يشمل العهدة/الحالة/الاستبعاد — لها مساراتها). */
export interface UpdateAssetInput {
  name: string;
  category: string;
  brand?: string | null;
  serial?: string | null;
  branchId?: number | null;
  location?: string | null;
  supplierId?: number | null;
  purchaseDate: string;
  purchaseValue: string;
  salvageValue?: string;
  usefulLifeYears: number;
  depreciationMethod?: "sl" | "db";
  condition?: string | null;
  warrantyEnd?: string | null;
}

export async function updateAsset(id: number, input: UpdateAssetInput, actor: Actor) {
  if (!(input.usefulLifeYears > 0)) throw new Error("العمر الإنتاجي يجب أن يكون أكبر من صفر");
  const scope = companyBranchScope(actor);
  await withTx(async (tx) => {
    const previewConds = [eq(fixedAssets.id, id)];
    if (scope.branchId != null) previewConds.push(eq(fixedAssets.branchId, scope.branchId));
    const [preview] = await tx
      .select({ branchId: fixedAssets.branchId })
      .from(fixedAssets)
      .where(and(...previewConds))
      .limit(1);
    if (!preview) throw new TRPCError({ code: "NOT_FOUND", message: "الأصل غير موجود" });
    const previewOldBranchId = preview.branchId == null ? null : Number(preview.branchId);
    const previewTargetBranchId = resolveTargetBranch(
      scope,
      input.branchId !== undefined ? input.branchId : previewOldBranchId,
      { required: false },
    );
    for (const branchId of Array.from(new Set([previewOldBranchId, previewTargetBranchId].filter((v): v is number => v != null))).sort((x, y) => x - y)) {
      await lockCashSourceForUpdate(tx, { branchId, cashBucket: "TREASURY", shiftId: null });
    }
    const a = await loadForUpdate(tx, id, scope);
    if ((a.branchId == null ? null : Number(a.branchId)) !== previewOldBranchId) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر فرع الأصل أثناء التعديل — أعد المحاولة" });
    }
    const targetBranchId = resolveTargetBranch(
      scope,
      input.branchId !== undefined ? input.branchId : (a.branchId == null ? null : Number(a.branchId)),
      { required: false },
    );
    const oldBranchId = a.branchId == null ? null : Number(a.branchId);
    const branchChanged = oldBranchId !== targetBranchId;
    if (targetBranchId !== previewTargetBranchId) {
      throw new TRPCError({ code: "CONFLICT", message: "تغيّر الفرع الهدف أثناء التعديل — أعد المحاولة" });
    }
    if (branchChanged && a.custodianId != null) {
      const [custodian] = await tx
        .select({ branchId: employees.branchId })
        .from(employees)
        .where(eq(employees.id, Number(a.custodianId)))
        .for("update")
        .limit(1);
      if (targetBranchId == null || !custodian || Number(custodian.branchId) !== targetBranchId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن نقل الأصل قبل إعادة العهدة أو إسنادها لموظف في الفرع الهدف",
        });
      }
    }
    if (branchChanged && a.linkedDeviceId != null) {
      const [device] = await tx
        .select({ branchId: kioskDevices.branchId })
        .from(kioskDevices)
        .where(eq(kioskDevices.id, Number(a.linkedDeviceId)))
        .for("update")
        .limit(1);
      if (targetBranchId == null || !device || Number(device.branchId) !== targetBranchId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "لا يمكن نقل الأصل ما دام مرتبطاً بجهاز في فرع مختلف",
        });
      }
    }
    if (a.status === "disposed") throw new Error("لا يمكن تعديل أصل مُستبعَد");

    // ASSET-REVAL (تدقيق ٢/٧): قيمة الشراء والمورّد مُرحَّلان محاسبياً عند الاقتناء (قيد PURCHASE +AP
    // أو PAYMENT_OUT، بمفتاح ASSET_ACQ:<id>) ويُغذّيان حساب الإهلاك. كان تعديلهما يُعيد الكتابة بلا
    // قيدٍ تعويضيّ ⇒ إهلاك على قيمة غير مرسملة + دين يبقى على المورّد الخطأ. الآن نُصحّح الدفتر:
    // نعكس أثر الاقتناء القديم (AP/نقد) ثم نُطبّق الجديد بمفاتيح فريدة — تصحيح خطأٍ محاسبيّ متّسق.
    const oldVal = money(a.purchaseValue ?? "0");
    const newVal = money(input.purchaseValue);
    const oldSup = a.supplierId != null ? Number(a.supplierId) : null;
    const newSup = input.supplierId ?? null;
    const financiallyChanged = !oldVal.eq(newVal) || oldSup !== newSup;

    if (financiallyChanged) {
      const uid = actor.userId;
      let oldCashWasPaid = oldSup == null;
      if (oldSup == null && oldVal.gt(0)) {
        const [latestCashRequest] = await tx
          .select()
          .from(receipts)
          .where(
            and(
              eq(receipts.direction, "OUT"),
              or(
                eq(receipts.referenceNumber, `ASSET-ACQ-${id}`),
                like(receipts.referenceNumber, `ASSET-REACQ-${id}-%`),
              ),
            ),
          )
          .orderBy(desc(receipts.id))
          .for("update")
          .limit(1);
        const systemRequest = parseSystemPaymentRequest(latestCashRequest?.internalNote);
        if (
          latestCashRequest &&
          (systemRequest?.kind === "ASSET_ACQUISITION" || systemRequest?.kind === "ASSET_REACQUISITION") &&
          systemRequest.assetId === id
        ) {
          oldCashWasPaid =
            latestCashRequest.status === "COMPLETED" &&
            latestCashRequest.approvalStatus === "APPROVED";
          if (latestCashRequest.approvalStatus === "PENDING_APPROVAL") {
            await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, Number(latestCashRequest.id)));
          } else if (oldCashWasPaid) {
            await tx.update(receipts).set({ status: "REVERSED" }).where(eq(receipts.id, Number(latestCashRequest.id)));
          }
        }
      }
      // لاحقة فريدة لكل تعديل (تفادي اصطدام uq_entry_dedupe عند تعديلٍ ثانٍ لنفس الأصل).
      const priorLedger = await tx
        .select({ c: sql<number>`COUNT(*)` })
        .from(accountingEntries)
        .where(like(accountingEntries.dedupeKey, `ASSET_REACQ:${id}:%`));
      const priorCashRequests = await tx
        .select({ c: sql<number>`COUNT(*)` })
        .from(receipts)
        .where(like(receipts.referenceNumber, `ASSET-REACQ-${id}-%`));
      const seq = Number(priorLedger[0]?.c ?? 0) + Number(priorCashRequests[0]?.c ?? 0) + 1;

      // (١) عكس أثر الاقتناء القديم.
      if (oldVal.gt(0)) {
        if (oldSup != null) {
          await adjustSupplierBalance(tx, oldSup, oldVal.neg());
          await postEntry(tx, {
            entryType: "PURCHASE", branchId: oldBranchId, supplierId: oldSup,
            cost: oldVal.neg(), amount: oldVal.neg(),
            dedupeKey: `ASSET_ACQREV:${id}:${seq}`, notes: `عكس اقتناء أصل ${a.code ?? id} (تعديل)`,
          });
        } else if (oldCashWasPaid) {
          if (oldBranchId == null) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "عكس اقتناء الأصل النقدي يتطلب فرع الاقتناء القديم",
            });
          }
          const rRes = await tx.insert(receipts).values({
            branchId: oldBranchId, cashBucket: "TREASURY", direction: "IN",
            amount: toDbMoney(oldVal), paymentMethod: "CASH", status: "COMPLETED",
            approvalStatus: "APPROVED", createdBy: uid,
          });
          await postEntry(tx, {
            entryType: "PAYMENT_OUT", branchId: oldBranchId, receiptId: extractInsertId(rRes), amount: oldVal.neg(),
            dedupeKey: `ASSET_ACQREV:${id}:${seq}`, notes: `عكس اقتناء أصل نقدي ${a.code ?? id} (تعديل)`,
          });
        }
      }

      // (٢) تطبيق أثر الاقتناء الجديد (مرآة create.ts).
      if (newVal.gt(0)) {
        if (newSup != null) {
          await postEntry(tx, {
            entryType: "PURCHASE", branchId: targetBranchId, supplierId: newSup,
            cost: newVal, amount: newVal,
            dedupeKey: `ASSET_REACQ:${id}:${seq}`, notes: `اقتناء أصل ${a.code ?? id} بعد تعديل (آجل — مورّد)`,
          });
          await adjustSupplierBalance(tx, newSup, newVal);
        } else {
          if (targetBranchId == null) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "إعادة اقتناء الأصل نقداً تتطلب فرعاً محدداً لخزينة الصرف",
            });
          }
          await createSystemPaymentRequestTx(tx, {
            branchId: targetBranchId,
            amount: toDbMoney(newVal),
            paymentMethod: "CASH",
            partyType: "OTHER",
            counterpartyName: input.name,
            description: `إعادة اقتناء أصل ${a.code ?? id} بعد تعديل (طلب دفع نقدي)`,
            referenceNumber: `ASSET-REACQ-${id}-${seq}`,
            voucherDate: input.purchaseDate,
            clientRequestId: `asset-reacquisition-${id}-${seq}`,
          }, actor, { kind: "ASSET_REACQUISITION", assetId: id, sequence: seq });
        }
      }
    }

    await tx
      .update(fixedAssets)
      .set({
        name: input.name,
        category: input.category as never,
        brand: input.brand ?? null,
        serial: input.serial ?? null,
        branchId: targetBranchId,
        location: input.location ?? null,
        supplierId: input.supplierId ?? null,
        purchaseDate: input.purchaseDate,
        purchaseValue: toDbMoney(input.purchaseValue),
        salvageValue: toDbMoney(input.salvageValue ?? "0"),
        usefulLifeYears: input.usefulLifeYears,
        depreciationMethod: input.depreciationMethod ?? "sl",
        condition: input.condition ?? null,
        warrantyEnd: input.warrantyEnd ?? null,
      })
      .where(eq(fixedAssets.id, id));

    // DEPR-REVAL (تدقيق ١٧/٧): تعديل القيمة/التخريدية/العمر/الطريقة بعد ترحيل إهلاكٍ لا يصحّح المتراكم
    // ⇒ عند خفض القيمة يبقى المتراكم > (القيمة−التخريدية) فيصير NBV سالباً، وكنسة catch-up تتخطّاه
    // للأبد (monthDep≤0). نُعيد حساب المتراكم الصحيح بالبارامترات الجديدة حتى اليوم (computeDepreciation
    // يقصُره على الأساس)، ونُرحّل قيد ADJUST تعويضيّاً بالفرق (مصروف الإهلاك يتبع المتراكم). نقتصر على
    // أصلٍ سبق إهلاكه (accum>0)؛ عديم الإهلاك تُغطّيه كنسة الإهلاك الشهريّ الطبيعيّة (لا خطر NBV سالب).
    const oldAccum = money(a.accumulatedDepreciation ?? "0");
    const depParamsChanged =
      !money(a.purchaseValue ?? "0").eq(newVal) ||
      !money(a.salvageValue ?? "0").eq(money(input.salvageValue ?? "0")) ||
      Number(a.usefulLifeYears) !== input.usefulLifeYears ||
      (((a.depreciationMethod as string) ?? "sl") !== (input.depreciationMethod ?? "sl"));
    if (depParamsChanged && oldAccum.gt(0)) {
      const correctAccum = money(
        computeDepreciation(
          {
            purchaseValue: input.purchaseValue,
            salvageValue: input.salvageValue ?? "0",
            usefulLifeYears: input.usefulLifeYears,
            depreciationMethod: input.depreciationMethod ?? "sl",
            purchaseDate: input.purchaseDate,
            status: a.status,
          },
          new Date(),
        ).accumulated,
      );
      const deprDelta = correctAccum.sub(oldAccum);
      if (!deprDelta.isZero()) {
        const depBranch = targetBranchId;
        const priorAdj = await tx
          .select({ c: sql<number>`COUNT(*)` })
          .from(accountingEntries)
          .where(like(accountingEntries.dedupeKey, `DEPR_ADJ:${id}:%`));
        const seq = Number(priorAdj[0]?.c ?? 0) + 1;
        await postEntry(tx, {
          entryType: "ADJUST",
          branchId: depBranch,
          cost: deprDelta,
          profit: deprDelta.neg(), // مصروف: revenue(0) − cost = ربح سالب (يجتاز reconcileLedgerProfit)
          amount: deprDelta,
          entryDate: new Date(),
          dedupeKey: `DEPR_ADJ:${id}:${seq}`,
          notes: `تصحيح إهلاك متراكم عند تعديل أصل ${a.code ?? id}`,
        });
        await tx
          .update(fixedAssets)
          .set({ accumulatedDepreciation: toDbMoney(correctAccum) })
          .where(eq(fixedAssets.id, id));
      }
    }
  });
  return getAsset(id, scope);
}
