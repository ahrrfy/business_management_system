/**
 * مصادرُ الخزينة: السندات، المصاريف، تصحيح الاستحقاق، فرق النقد.
 *
 * ⭐ **البوّابة الفعليّة لا بوّابة الراوتر وحدها:** `vouchers.approve` على `treasuryManagerProcedure`
 * لكنّ `approveVoucher` نفسها ترفض غيرَ المالك («اعتماد السندات محصور بحساب مالك نشط»)؛
 * فالمصدر يعلن `OWNER` — إظهارُ صفٍّ يرفضه الخادم حتماً أسوأ من إخفائه.
 */
import { and, eq, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { cashVarianceApprovalTrigger, voucherApprovalTrigger } from "@shared/approvalTriggers";
import { CASH_VARIANCE_REASON_LABELS } from "@shared/cashVariance";
import {
  decisionSubkindLabel,
  type DecisionOperationalContext,
  type DecisionSummaryItem,
} from "@shared/decisionRegistry";
import { expenseBucketLabel } from "@shared/expenseCategories";
import {
  accrualCorrectionRequests,
  accrualObligations,
  cashVarianceCases,
  customers,
  employees,
  expenseCategories,
  expenses,
  fixedAssets,
  productUnits,
  productVariants,
  purchaseOrderItems,
  purchaseOrders,
  receipts,
  shifts,
  suppliers,
  users,
  voucherCategories,
} from "../../../../drizzle/schema";
import { approveAccrualCorrection, rejectAccrualCorrection } from "../../accounting/accrualCorrection";
import { approveCashVarianceCase, listCashVarianceCases, rejectCashVarianceCase } from "../../cashVarianceService";
import { approveExpense, rejectExpense } from "../../expenseService";
import { requireDb } from "../../tx";
import { approveVoucher, rejectVoucher } from "../../voucher/approval";
import { parseSystemPaymentRequest } from "../../voucher/create";
import { serviceActor } from "../gate";
import { buildRow, decided, defaultMessage, itemLabel } from "../rows";
import type { DecisionSource } from "../types";
import {
  branchIdsFor,
  branchNames,
  customerNames,
  freshnessFrom,
  ids,
  scopeBranch,
  serviceBranchScopedIds,
  sodHidden,
  supplierNames,
  unitNames,
  userNames,
  variantLabels,
  type Db,
} from "./common";

const TREASURY_GATE = { type: "MODULE", moduleKey: "treasury", roles: ["manager", "accountant"] } as const;

async function employeeDisplayNames(db: Db, employeeIds: number[]): Promise<Map<number, string>> {
  if (!employeeIds.length) return new Map();
  const rows = await db
    .select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName })
    .from(employees)
    .where(inArray(employees.id, employeeIds));
  return new Map(rows.map((e) => [Number(e.id), [e.firstName, e.lastName].filter(Boolean).join(" ")]));
}

async function categoryNames(db: Db, categoryIds: number[]): Promise<Map<number, string>> {
  if (!categoryIds.length) return new Map();
  const rows = await db
    .select({ id: voucherCategories.id, name: voucherCategories.name })
    .from(voucherCategories)
    .where(inArray(voucherCategories.id, categoryIds));
  return new Map(rows.map((c) => [Number(c.id), c.name]));
}

// ───────────────────────────── ١) السندات ─────────────────────────────

/**
 * [`voucherRouter.ts:153`](../../../routers/voucherRouter.ts) ⇐ `approveVoucher`/`rejectVoucher`.
 * الشروط مرآةُ `superApp.approvalInbox`: معلَّقٌ، ليس مصروفاً، ليس مربوطاً بفاتورة، وله رقمُ سند
 * (بلا رقمٍ ترفضه الخدمة بـ«السند غير موجود»).
 */
export const voucherSource: DecisionSource = {
  key: "treasury.voucher",
  kinds: ["treasury.voucher.approve", "treasury.voucher.reject"],
  gate: { type: "OWNER", moduleKey: "treasury" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const db = requireDb();
    const rows = await db
      .select({
        id: receipts.id,
        voucherNumber: receipts.voucherNumber,
        amount: receipts.amount,
        direction: receipts.direction,
        paymentMethod: receipts.paymentMethod,
        description: receipts.description,
        partyType: receipts.partyType,
        partyId: receipts.partyId,
        counterpartyName: receipts.counterpartyName,
        voucherCategoryId: receipts.voucherCategoryId,
        referenceNumber: receipts.referenceNumber,
        cashBucket: receipts.cashBucket,
        shiftId: receipts.shiftId,
        branchId: receipts.branchId,
        createdBy: receipts.createdBy,
        createdByName: users.name,
        createdAt: receipts.createdAt,
        internalNote: receipts.internalNote,
      })
      .from(receipts)
      .leftJoin(users, eq(users.id, receipts.createdBy))
      .where(
        and(
          eq(receipts.status, "PENDING"),
          eq(receipts.approvalStatus, "PENDING_APPROVAL"),
          isNotNull(receipts.voucherNumber),
          isNull(receipts.invoiceId),
          notExists(db.select({ id: expenses.id }).from(expenses).where(eq(expenses.receiptId, receipts.id))),
          branchId == null ? undefined : eq(receipts.branchId, branchId),
        ),
      )
      .orderBy(sql`${receipts.createdAt} ASC`)
      .limit(200);

    const names = await branchNames(db, ids(rows.map((r) => r.branchId)));

    const sysRequests = rows.map((r) => parseSystemPaymentRequest(r.internalNote));

    const poIds = ids(
      sysRequests.map((s) => (s && "purchaseOrderId" in s ? s.purchaseOrderId : null)),
    );
    const voucherCategoryIds = ids(rows.map((r) => r.voucherCategoryId));
    const assetIds = ids(
      sysRequests.map((s) => (s && "assetId" in s ? s.assetId : null)),
    );
    const employeeIds = ids(
      sysRequests.map((s) => (s && s.kind === "EMPLOYEE_ADVANCE" ? s.employeeId : null)),
    );
    const shiftIds = ids(
      rows.flatMap((r, idx) => {
        const s = sysRequests[idx];
        const sId = s && "shiftId" in s ? s.shiftId : null;
        return [r.shiftId, sId];
      }),
    );
    const partySupplierIds = ids(
      rows.map((r) => (r.partyType === "SUPPLIER" ? r.partyId : null)),
    );
    const partyCustomerIds = ids(
      rows.map((r) => (r.partyType === "CUSTOMER" ? r.partyId : null)),
    );

    const [
      posList,
      poItemsList,
      categoriesMap,
      shiftsList,
      assetsList,
      employeeNamesMap,
      customerNamesMap,
    ] = await Promise.all([
      poIds.length
        ? db
            .select({
              id: purchaseOrders.id,
              poNumber: purchaseOrders.poNumber,
              supplierId: purchaseOrders.supplierId,
              total: purchaseOrders.total,
              usdTotal: purchaseOrders.usdTotal,
              agreedCurrency: purchaseOrders.agreedCurrency,
              status: purchaseOrders.status,
              createdAt: purchaseOrders.createdAt,
            })
            .from(purchaseOrders)
            .where(inArray(purchaseOrders.id, poIds))
        : [],
      poIds.length
        ? db
            .select({
              id: purchaseOrderItems.id,
              purchaseOrderId: purchaseOrderItems.purchaseOrderId,
              variantId: purchaseOrderItems.variantId,
              productUnitId: purchaseOrderItems.productUnitId,
              quantity: purchaseOrderItems.quantity,
              unitPrice: purchaseOrderItems.unitPrice,
              usdUnitPrice: purchaseOrderItems.usdUnitPrice,
            })
            .from(purchaseOrderItems)
            .where(inArray(purchaseOrderItems.purchaseOrderId, poIds))
        : [],
      categoryNames(db, voucherCategoryIds),
      shiftIds.length
        ? db
            .select({ id: shifts.id, shiftType: shifts.shiftType, status: shifts.status })
            .from(shifts)
            .where(inArray(shifts.id, shiftIds))
        : [],
      assetIds.length
        ? db
            .select({ id: fixedAssets.id, name: fixedAssets.name, code: fixedAssets.code })
            .from(fixedAssets)
            .where(inArray(fixedAssets.id, assetIds))
        : [],
      employeeDisplayNames(db, employeeIds),
      customerNames(db, partyCustomerIds),
    ]);

    const allSupplierIds = ids([
      ...partySupplierIds,
      ...posList.map((p) => p.supplierId),
      ...sysRequests.map((s) => (s && "supplierId" in s ? s.supplierId : null)),
      ...sysRequests.map((s) =>
        s && "beneficiaryId" in s && s.beneficiaryType === "SUPPLIER" ? s.beneficiaryId : null,
      ),
    ]);

    const [supplierNamesMap, variantLabelsMap, unitNamesMap] = await Promise.all([
      supplierNames(db, allSupplierIds),
      variantLabels(db, ids(poItemsList.map((i) => i.variantId))),
      unitNames(db, ids(poItemsList.map((i) => i.productUnitId))),
    ]);

    const poById = new Map(posList.map((p) => [Number(p.id), p]));
    const shiftsMap = new Map(shiftsList.map((s) => [Number(s.id), s]));
    const assetsMap = new Map(assetsList.map((a) => [Number(a.id), a]));
    const poItemsByPoId = new Map<number, typeof poItemsList>();
    for (const item of poItemsList) {
      const pid = Number(item.purchaseOrderId);
      const list = poItemsByPoId.get(pid) ?? [];
      list.push(item);
      poItemsByPoId.set(pid, list);
    }

    // قرار المالك (٣/٩/٢٦): المالك يعتمد سنده — لا إخفاء لصانع الطلب هنا.
    return rows.map((r, idx) => {
      const sysReq = sysRequests[idx];
      let subkind = decisionSubkindLabel(r.direction);
      let title = `${subkind} ${r.voucherNumber ?? ""} · ${r.paymentMethod}`;
      let party = r.counterpartyName?.trim() || null;
      let reason = r.description?.trim() || null;
      let operationalContext: DecisionOperationalContext | null = null;
      const summaryItems: DecisionSummaryItem[] = [];

      if (sysReq?.kind === "PURCHASE_SHIPPING") {
        const po = poById.get(Number(sysReq.purchaseOrderId));
        const supName = po?.supplierId ? supplierNamesMap.get(Number(po.supplierId)) ?? null : null;
        const fundingMode = sysReq.fundingSource ?? (r.cashBucket === "DRAWER" ? "DRAWER" : "TREASURY");
        const effectiveShiftId = sysReq.shiftId ?? r.shiftId ?? null;
        const shiftObj = effectiveShiftId ? shiftsMap.get(Number(effectiveShiftId)) : null;
        const fundingLabel = fundingMode === "DRAWER"
          ? `درج كاشير (وردية #${effectiveShiftId ?? "—"})`
          : "خزينة الفرع الرئيسية";

        const isCarrierGeneric = !r.counterpartyName || r.counterpartyName.trim() === "ناقل غير محدّد";
        subkind = "تسوية شحن وتخليص مشتريات";
        title = `سند صرف ${r.paymentMethod === "CASH" ? "نقدي" : r.paymentMethod} · تسوية شحن وتخليص مشتريات (${r.voucherNumber ?? ""})`;
        party = isCarrierGeneric
          ? (supName ? `ناقل غير محدّد (أمر شراء ${po?.poNumber ?? ""} — المورد: ${supName})` : "ناقل غير محدّد (تسوية شحن أمر شراء)")
          : `${r.counterpartyName}${supName ? ` (مورد البضاعة: ${supName})` : ""}`;

        const poTotalVal = Number(po?.total ?? 0);
        const voucherAmountVal = Number(r.amount ?? 0);
        const pct = poTotalVal > 0 ? ((voucherAmountVal / poTotalVal) * 100).toFixed(1) : null;

        const poItems = po ? (poItemsByPoId.get(Number(po.id)) ?? []).slice(0, 5) : [];
        const itemsSummary: DecisionSummaryItem[] = poItems.map((i) => {
          const v = variantLabelsMap.get(Number(i.variantId));
          const u = i.productUnitId ? unitNamesMap.get(Number(i.productUnitId)) : null;
          return {
            label: `بضاعة مستلمة: ${itemLabel([v?.productName, v?.variantName])}`,
            qty: i.quantity,
            unit: u ?? null,
            unitPrice: po?.agreedCurrency === "USD" ? i.usdUnitPrice : i.unitPrice,
          };
        });

        summaryItems.push({
          label: `أجور شحن ونقل جمركي مستحقة${po ? ` — أمر الشراء ${po.poNumber}` : ""}`,
          unitPrice: r.amount,
        });
        summaryItems.push(...itemsSummary);

        reason = po
          ? `تسوية استحقاق شحن وتخليص جمركي للبضاعة المستلمة بموجب أمر الشراء ${po.poNumber}${supName ? ` من المورد ${supName}` : ""}`
          : r.description?.trim() || null;

        operationalContext = {
          badgeLabel: "تسوية شحن وتخليص مشتريات",
          sourceDocument: po ? {
            type: "أمر شراء",
            number: po.poNumber,
            href: `/purchases/${po.id}`,
            date: po.createdAt ? new Date(po.createdAt).toISOString() : null,
            totalAmount: po.agreedCurrency === "USD" ? (po.usdTotal ?? po.total) : po.total,
            currency: (po.agreedCurrency ?? "IQD") as "IQD" | "USD",
          } : null,
          underlyingParty: supName ? {
            type: "SUPPLIER",
            name: supName,
            role: "مورد بضاعة الشحنة الأصلية",
          } : null,
          fundingSource: {
            mode: fundingMode,
            label: fundingLabel,
            shiftId: effectiveShiftId,
          },
          facts: [
            ...(po ? [{ label: "أمر الشراء المرتبط", value: po.poNumber }] : []),
            ...(supName ? [{ label: "مورد البضاعة", value: supName }] : []),
            ...(po ? [{
              label: "إجمالي قيمة البضاعة",
              value: `${po.agreedCurrency === "USD" ? (po.usdTotal ?? po.total) : po.total} ${po.agreedCurrency === "USD" ? "$" : "د.ع"}`,
            }] : []),
            ...(pct ? [{
              label: "نسبة الشحن من الطلب",
              value: `${pct}%`,
              badge: Number(pct) > 25 ? "نسبة شحن مرتفعة" : undefined,
              tone: Number(pct) > 25 ? ("warn" as const) : ("default" as const),
            }] : []),
            { label: "مصدر خروج المال", value: fundingLabel },
            { label: "حالة استلام البضاعة", value: "إقرار وصول كامل معتمد", tone: "success" as const },
          ],
          smartNotice: isCarrierGeneric
            ? {
                tone: "warn",
                text: `تنبيه المعتمد: أُنشئ هذا السند آلياً كاستحقاق شحن وتخليص لأمر الشراء ${po?.poNumber ?? ""} دون تسجيل اسم شركة النقل في إقرار الاستلام. يُرجى التحقق من وصل الشحن أو الفاتورة اليدوية المرفقة ومطابقتها قبل اعتماد خروج النقد.`,
              }
            : {
                tone: "info",
                text: `تم تأكيد استلام كامل بنود أمر الشراء ${po?.poNumber ?? ""} وتثبيت الناقل (${r.counterpartyName}). السند جاهز للمطابقة المالية والاعتماد.`,
              },
        };
      } else if (sysReq?.kind === "PURCHASE_SUPPLIER" || sysReq?.kind === "PURCHASE_SUPPLIER_USD") {
        const po = poById.get(Number(sysReq.purchaseOrderId));
        const supName = po?.supplierId ? supplierNamesMap.get(Number(po.supplierId)) ?? null : null;
        subkind = "سداد فاتورة مورد";
        title = `سند صرف · سداد فاتورة مورد (${r.voucherNumber ?? ""})`;
        party = supName ?? r.counterpartyName;
        summaryItems.push({
          label: `سداد مستحقات المورد${supName ? ` ${supName}` : ""}${po ? ` عن أمر الشراء ${po.poNumber}` : ""}`,
          unitPrice: r.amount,
        });
        operationalContext = {
          badgeLabel: "سداد فاتورة مورد مشتريات",
          sourceDocument: po ? {
            type: "أمر شراء",
            number: po.poNumber,
            href: `/purchases/${po.id}`,
            totalAmount: po.total,
            currency: (po.agreedCurrency ?? "IQD") as "IQD" | "USD",
          } : null,
          underlyingParty: supName ? { type: "SUPPLIER", name: supName, role: "المورد المستحق" } : null,
          facts: [
            ...(po ? [{ label: "أمر الشراء", value: po.poNumber }] : []),
            ...(supName ? [{ label: "المورد", value: supName }] : []),
            { label: "طريقة السداد", value: r.paymentMethod },
          ],
          smartNotice: {
            tone: "info",
            text: "سداد رسمي لفاتورة المورد المقفلة بأمر الشراء. اعتماده يوثق سداد الذمة وخروج النقد.",
          },
        };
      } else if (sysReq?.kind === "ASSET_ACQUISITION" || sysReq?.kind === "ASSET_MAINTENANCE" || sysReq?.kind === "ASSET_SUPPLIER_SETTLEMENT") {
        const asset = assetsMap.get(Number(sysReq.assetId));
        subkind = sysReq.kind === "ASSET_ACQUISITION" ? "شراء أصل ثابت" : "صيانة أصل ثابت";
        title = `سند صرف · ${subkind} (${r.voucherNumber ?? ""})`;
        summaryItems.push({
          label: `${subkind}${asset ? `: ${asset.name} (${asset.code})` : ""}`,
          unitPrice: r.amount,
        });
        operationalContext = {
          badgeLabel: subkind,
          facts: [
            ...(asset ? [{ label: "الأصل الرأسمالي", value: `${asset.name} (${asset.code})` }] : []),
            { label: "المستفيد", value: r.counterpartyName ?? "غير محدد" },
          ],
          smartNotice: {
            tone: "info",
            text: "سند مرتبط بسجل الأصول الرأسمالية. اعتماده يثبت قيد المعاملة ويصرف النقد.",
          },
        };
      } else if (sysReq?.kind === "EMPLOYEE_ADVANCE") {
        const empName = employeeNamesMap.get(Number(sysReq.employeeId));
        subkind = "سلفة موظف";
        title = `سند صرف · سلفة موظف (${r.voucherNumber ?? ""})`;
        party = empName ?? r.counterpartyName;
        summaryItems.push({
          label: `صرف سلفة للموظف ${empName ?? ""}${sysReq.note ? ` (${sysReq.note})` : ""}`,
          unitPrice: r.amount,
        });
        operationalContext = {
          badgeLabel: "سلفة موظف",
          underlyingParty: empName ? { type: "EMPLOYEE", name: empName, role: "الموظف المستفيد" } : null,
          facts: [
            ...(empName ? [{ label: "الموظف", value: empName }] : []),
            ...(sysReq.monthlyDeduction ? [{ label: "الاستقطاع الشهري", value: `${sysReq.monthlyDeduction} د.ع` }] : []),
            ...(sysReq.note ? [{ label: "ملاحظات", value: sysReq.note }] : []),
          ],
          smartNotice: {
            tone: "info",
            text: "سلفة موظف تُسترد عبر الاستقطاع الشهري من الراتب. اعتماده يصرف السلفة ويثبت مديونية الموظف.",
          },
        };
      } else if (sysReq?.kind === "VOUCHER_CANCELLATION") {
        subkind = "إلغاء سند مالي";
        title = `سند عكس وإلغاء · سند سابق #${sysReq.originalReceiptId} (${r.voucherNumber ?? ""})`;
        summaryItems.push({
          label: `إلغاء السند الأصلي #${sysReq.originalReceiptId} (${sysReq.originalPaymentMethod})`,
          unitPrice: r.amount,
        });
        operationalContext = {
          badgeLabel: "إلغاء وعكس سند مالي",
          facts: [
            { label: "السند الأصلي", value: `#${sysReq.originalReceiptId}` },
            { label: "طريقة الدفع الأصلية", value: sysReq.originalPaymentMethod },
            ...(sysReq.reissueReason ? [{ label: "سبب الإلغاء", value: sysReq.reissueReason }] : []),
          ],
          smartNotice: {
            tone: "warn",
            text: "إلغاء السند يمحو أثره المالي السابق ويعكس قيوده. يرجى التحقق من أسباب الإلغاء.",
          },
        };
      } else {
        // Regular voucher
        const catName = r.voucherCategoryId ? categoriesMap.get(Number(r.voucherCategoryId)) : null;
        const resolvedParty = r.partyType === "SUPPLIER"
          ? (r.partyId ? supplierNamesMap.get(Number(r.partyId)) : null)
          : r.partyType === "CUSTOMER"
            ? (r.partyId ? customerNamesMap.get(Number(r.partyId)) : null)
            : r.counterpartyName;
        party = resolvedParty ?? r.counterpartyName;
        const fundingLabel = r.cashBucket === "DRAWER"
          ? `درج كاشير (وردية #${r.shiftId ?? "—"})`
          : "خزينة الفرع الرئيسية";

        summaryItems.push({
          label: r.description?.trim() || (catName ? `سند ${decisionSubkindLabel(r.direction)} — ${catName}` : "بلا وصف"),
          unitPrice: r.amount,
        });

        operationalContext = {
          badgeLabel: catName ? `سند ${decisionSubkindLabel(r.direction)} (${catName})` : `سند ${decisionSubkindLabel(r.direction)} عام`,
          underlyingParty: party ? {
            type: r.partyType === "SUPPLIER" ? "SUPPLIER" : r.partyType === "CUSTOMER" ? "CUSTOMER" : "OTHER",
            name: party,
            role: r.partyType === "SUPPLIER" ? "المورد" : r.partyType === "CUSTOMER" ? "الزبون" : "الطرف الخارجي",
          } : null,
          fundingSource: {
            mode: r.cashBucket === "DRAWER" ? "DRAWER" : "TREASURY",
            label: fundingLabel,
            shiftId: r.shiftId ?? null,
          },
          facts: [
            ...(party ? [{ label: "الطرف", value: party }] : []),
            ...(catName ? [{ label: "التصنيف", value: catName }] : []),
            { label: "طريقة الدفع", value: r.paymentMethod },
            ...(r.referenceNumber ? [{ label: "المرجع", value: r.referenceNumber }] : []),
            { label: "مصدر النقد", value: fundingLabel },
          ],
          smartNotice: {
            tone: "info",
            text: r.direction === "OUT"
              ? "سند صرف يدوي. اعتماده يصرف المبلغ من الخزينة أو الدرج ويثبت قيد المصروف/الذمة."
              : "سند قبض يدوي. اعتماده يثبت استلام النقد في الخزينة أو الدرج ويقيد التحصيل.",
          },
        };
      }

      return buildRow(
        {
          kind: "treasury.voucher.approve",
          id: Number(r.id),
          title,
          subkind,
          party,
          amount: r.amount,
          branchId: r.branchId == null ? null : Number(r.branchId),
          branchName: r.branchId == null ? null : (names.get(Number(r.branchId)) ?? null),
          requestedBy: r.createdBy == null ? null : Number(r.createdBy),
          requestedByName: r.createdByName ?? null,
          requestedAt: r.createdAt,
          summaryItems: summaryItems.length ? summaryItems : [{ label: r.description ?? "بلا وصف", unitPrice: r.amount }],
          reason,
          trigger: voucherApprovalTrigger(r.direction, r.internalNote?.startsWith("VOUCHER_CANCELLATION") ? "VOUCHER_CANCELLATION" : null),
          operationalContext,
        },
        scope.now,
      );
    });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => {
        const [row] = await requireDb()
          .select({ status: receipts.status, approvalStatus: receipts.approvalStatus })
          .from(receipts)
          .where(eq(receipts.id, id))
          .limit(1);
        return row?.status === "PENDING" ? row.approvalStatus : undefined;
      },
      ["PENDING_APPROVAL"],
    ),
  async decide(input, actor) {
    const subject = `السند رقم ${input.id}`;
    if (input.action === "REJECT") {
      const res = await rejectVoucher(input.id, serviceActor(actor), input.reason ?? "");
      return decided(input, "REJECTED", `السند ${res.voucherNumber}: رُفض وسُجّل السبب.`);
    }
    const res = await approveVoucher(input.id, serviceActor(actor));
    return decided(input, "EXECUTED", res.replayed ? `${subject}: كان معتمداً من قبل — لا أثر ثانٍ.` : `السند ${res.voucherNumber}: اعتُمد وسُجّل أثره الماليّ.`);
  },
};

// ───────────────────────────── ٢) المصاريف ─────────────────────────────

/**
 * [`expenseRouter.ts:383`](../../../routers/expenseRouter.ts) ⇐ `approveExpense` (ownerProcedure).
 * الشروط مرآةُ `actionableExpenseApprovalWhere` في `superAppRouter.ts` (مصروفٌ نقديّ معلَّق
 * إيصالُه معلَّق بلا درجٍ ولا وردية ولا مستندٍ آخر).
 */
export const expenseSource: DecisionSource = {
  key: "expense",
  kinds: ["expense.approve", "expense.reject"],
  gate: { type: "OWNER" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const db = requireDb();
    const rows = await db
      .select({
        id: expenses.id,
        category: expenses.category,
        expenseCategoryName: expenseCategories.name,
        costCenter: expenses.costCenter,
        amount: expenses.amount,
        paymentMethod: expenses.paymentMethod,
        description: expenses.description,
        payee: expenses.payee,
        branchId: expenses.branchId,
        createdBy: expenses.createdBy,
        createdByName: users.name,
        createdAt: expenses.createdAt,
        expenseDate: expenses.expenseDate,
        referenceNumber: expenses.referenceNumber,
      })
      .from(expenses)
      .innerJoin(receipts, eq(expenses.receiptId, receipts.id))
      .leftJoin(
        expenseCategories,
        eq(expenses.expenseCategoryId, expenseCategories.id),
      )
      .leftJoin(users, eq(users.id, expenses.createdBy))
      .where(
        and(
          eq(expenses.status, "PENDING_APPROVAL"),
          eq(expenses.source, "CASH"),
          eq(receipts.direction, "OUT"),
          eq(receipts.status, "PENDING"),
          eq(receipts.approvalStatus, "PENDING_APPROVAL"),
          isNull(expenses.shiftId),
          isNull(expenses.cashBucket),
          isNull(receipts.shiftId),
          isNull(receipts.cashBucket),
          isNull(receipts.invoiceId),
          isNull(receipts.workOrderId),
          isNull(receipts.reservationId),
          isNull(receipts.voucherNumber),
          sql`${expenses.createdBy} IS NOT NULL`,
          branchId == null ? undefined : eq(expenses.branchId, branchId),
        ),
      )
      .orderBy(sql`${expenses.createdAt} ASC`)
      .limit(200);
    const names = await branchNames(db, ids(rows.map((r) => r.branchId)));
    return rows.map((r) => {
      const categoryLabel = r.expenseCategoryName?.trim() || expenseBucketLabel(r.category);
      const costCenterPart = r.costCenter?.trim() ? ` · ${r.costCenter.trim()}` : "";
      const operationalContext: DecisionOperationalContext = {
        badgeLabel: `مصروف تشغيلي (${categoryLabel})`,
        underlyingParty: r.payee?.trim()
          ? {
              type: "OTHER",
              name: r.payee.trim(),
              role: "الجهة المستفيدة / المدفوع له",
            }
          : null,
        fundingSource: {
          mode: "TREASURY",
          label: "خزينة الفرع أو درج المنفذ (يُحدد عند الصرف)",
        },
        facts: [
          { label: "التصنيف", value: categoryLabel },
          ...(r.costCenter?.trim() ? [{ label: "مركز التكلفة", value: r.costCenter.trim() }] : []),
          ...(r.payee?.trim() ? [{ label: "المدفوع له", value: r.payee.trim() }] : []),
          { label: "طريقة الدفع المقترحة", value: r.paymentMethod },
          ...(r.referenceNumber?.trim() ? [{ label: "رقم المرجع", value: r.referenceNumber.trim() }] : []),
          ...(r.expenseDate ? [{ label: "تاريخ المصروف", value: String(r.expenseDate) }] : []),
        ],
        smartNotice: {
          tone: "info",
          text: "اعتماد المصروف يصادق على استحقاقه ويحوله للتنفيذ المالي. لم يتحرك النقد بعد وسيتطلب صرفاً نقدياً من الدرج أو الخزينة.",
        },
      };

      return buildRow(
        {
          kind: "expense.approve",
          id: Number(r.id),
          title: `مصروف ${categoryLabel}${costCenterPart} · ${r.paymentMethod}`,
          subkind: categoryLabel,
          party: r.payee,
          amount: r.amount,
          branchId: Number(r.branchId),
          branchName: names.get(Number(r.branchId)) ?? null,
          requestedBy: r.createdBy == null ? null : Number(r.createdBy),
          requestedByName: r.createdByName ?? null,
          requestedAt: r.createdAt,
          summaryItems: [
            { label: r.description?.trim() || "بلا وصف", unitPrice: r.amount },
            ...(r.costCenter?.trim() ? [{ label: `مركز التكلفة: ${r.costCenter.trim()}` }] : []),
            ...(r.referenceNumber?.trim() ? [{ label: `المرجع: ${r.referenceNumber.trim()}` }] : []),
          ],
          reason: r.description?.trim() || null,
          trigger: "MONEY_OUT",
          operationalContext,
        },
        scope.now,
      );
    });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: expenses.status }).from(expenses).where(eq(expenses.id, id)).limit(1))[0]?.status,
      ["PENDING_APPROVAL"],
    ),
  async decide(input, actor) {
    const subject = `المصروف رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectExpense(input.id, serviceActor(actor), input.reason ?? "");
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    await approveExpense(input.id, serviceActor(actor));
    return decided(
      input,
      "REQUESTED",
      `${subject}: اعتُمد وينتظر تنفيذ الدفع من درج المنفذ أو خزينة الفرع. لم يتحرك النقد ولم يُسجّل قيد الصرف بعد.`,
    );
  },
};

// ───────────────────────────── ٣) تصحيح الاستحقاق ─────────────────────────────

/**
 * [`expenseRouter.ts:255`](../../../routers/expenseRouter.ts) ⇐ `approveAccrualCorrection` (ownerProcedure).
 * الاعتماد يعكس اعترافاً قائماً (وربّما يُنشئ استرداداً) ⇒ محوُ أثر.
 */
export const accrualCorrectionSource: DecisionSource = {
  key: "expense.accrualCorrection",
  kinds: ["expense.accrualCorrection.approve", "expense.accrualCorrection.reject"],
  gate: { type: "OWNER" },
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const branchId = scopeBranch(actor, scope);
    if (branchId === "NONE") return [];
    const db = requireDb();
    const rows = await db
      .select({
        id: accrualCorrectionRequests.id,
        reason: accrualCorrectionRequests.reason,
        evidence: accrualCorrectionRequests.externalEvidenceReference,
        refundPaymentMethod: accrualCorrectionRequests.refundPaymentMethod,
        requestedBy: accrualCorrectionRequests.requestedBy,
        requestedAt: accrualCorrectionRequests.requestedAt,
        previousStatus: accrualCorrectionRequests.previousObligationStatus,
        obligationKind: accrualObligations.kind,
        branchId: accrualObligations.branchId,
        amount: accrualObligations.recognizedAmount,
        beneficiaryName: accrualObligations.beneficiaryName,
      })
      .from(accrualCorrectionRequests)
      .innerJoin(accrualObligations, eq(accrualObligations.id, accrualCorrectionRequests.obligationId))
      .where(and(eq(accrualCorrectionRequests.status, "PENDING"), branchId == null ? undefined : eq(accrualObligations.branchId, branchId)))
      .orderBy(sql`${accrualCorrectionRequests.requestedAt} ASC`)
      .limit(200);
    const [names, people] = await Promise.all([branchNames(db, ids(rows.map((r) => r.branchId))), userNames(db, ids(rows.map((r) => r.requestedBy)))]);
    return rows.map((r) => {
      const operationalContext: DecisionOperationalContext = {
        badgeLabel: `تصحيح استحقاق (${r.obligationKind})`,
        underlyingParty: r.beneficiaryName
          ? {
              type: "OTHER",
              name: r.beneficiaryName,
              role: "المستفيد",
            }
          : null,
        facts: [
          { label: "نوع الالتزام", value: r.obligationKind },
          { label: "الحالة السابقة", value: r.previousStatus },
          ...(r.refundPaymentMethod ? [{ label: "طريقة الاسترداد", value: r.refundPaymentMethod }] : []),
          ...(r.evidence ? [{ label: "الدليل الخارجي", value: r.evidence }] : []),
        ],
        smartNotice: {
          tone: "warn",
          text: "الاعتماد يعكس اعترافاً مالياً سابقاً ويلغي أثره أو ينشئ استرداداً. يرجى مراجعة الدليل الخارجي بعناية.",
        },
      };

      return buildRow(
        {
          kind: "expense.accrualCorrection.approve",
          id: Number(r.id),
          title: `تصحيح استحقاق ${r.obligationKind} · كان ${r.previousStatus}`,
          subkind: r.refundPaymentMethod ? `استرداد ${r.refundPaymentMethod}` : "عكس اعتراف",
          party: r.beneficiaryName,
          amount: r.amount,
          branchId: Number(r.branchId),
          branchName: names.get(Number(r.branchId)) ?? null,
          requestedBy: Number(r.requestedBy),
          requestedByName: people.get(Number(r.requestedBy)) ?? null,
          requestedAt: r.requestedAt,
          summaryItems: [{ label: `الدليل الخارجي: ${r.evidence}`, unitPrice: r.amount }],
          reason: r.reason,
          trigger: "ERASE_EFFECT",
          operationalContext,
        },
        scope.now,
      );
    });
  },
  freshness: (id) =>
    freshnessFrom(
      async () => (await requireDb().select({ status: accrualCorrectionRequests.status }).from(accrualCorrectionRequests).where(eq(accrualCorrectionRequests.id, id)).limit(1))[0]?.status,
      ["PENDING"],
    ),
  async decide(input, actor) {
    const subject = `طلب تصحيح الاستحقاق رقم ${input.id}`;
    if (input.action === "REJECT") {
      await rejectAccrualCorrection(input.id, input.reason ?? "", serviceActor(actor));
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    await approveAccrualCorrection(input.id, serviceActor(actor));
    return decided(input, "EXECUTED", defaultMessage("EXECUTED", subject));
  },
};

// ───────────────────────────── ٤) فرق النقد ─────────────────────────────

/**
 * [`cashVarianceRouter.ts:116`](../../../routers/cashVarianceRouter.ts) ⇐ `approveCashVarianceCase`.
 * فصلُ المهام في الخدمة: مقترحُ التسوية لا يعتمدها. القفلُ التفاؤليّ `expectedVersion` = نسخةُ
 * آخر حدث. سببُ الرفض عشرةُ محارف فأكثر.
 *
 * **الفروع:** الخدمة تسرد فرعاً واحداً وتقصر غيرَ الأدمن على فرعه (`assertBranchScope`)، فالأدمن
 * على «كلّ الفروع» يُعدِّد الفروعَ النشطة كلَّها ويسرد لكلٍّ (كما مصادر المشتريات) — كان المصدر
 * يستبدل `actor.branchId` فتختفي قضايا الفروع الأخرى من صندوق الأدمن (Codex على #1004).
 */
export const cashVarianceSource: DecisionSource = {
  key: "cash.variance",
  kinds: ["cash.variance.approve", "cash.variance.reject"],
  gate: TREASURY_GATE,
  supportedActions: ["APPROVE", "REJECT"],
  async list(actor, scope) {
    const db = requireDb();
    const a = serviceActor(actor);
    const all = actor.role === "admin" ? await branchIdsFor(db, actor, scope) : [];
    const branchIds = serviceBranchScopedIds(actor, scope.branchIds, all);
    if (!branchIds.length) return [];
    const pages = await Promise.all(branchIds.map((b) => listCashVarianceCases({ branchId: b, status: "PROPOSED", limit: 100 }, a)));
    const rows = pages.flatMap((p) => p.rows);
    const [names, people] = await Promise.all([
      branchNames(db, ids(rows.map((r) => r.branchId))),
      userNames(db, ids(rows.map((r) => r.proposedByUserId))),
    ]);
    return rows
      .filter((r) => !sodHidden({ blocked: [r.proposedByUserId], actor, trigger: "ERASE_EFFECT" }))
      .map((r) => {
        const shortage = Number(r.variance) < 0;
        const operationalContext: DecisionOperationalContext = {
          badgeLabel: shortage ? "عجز نقد وردية" : "فائض نقد وردية",
          underlyingParty: r.responsibleNameSnapshot
            ? {
                type: "EMPLOYEE",
                name: r.responsibleNameSnapshot,
                role: "المسؤول عن الوردية",
              }
            : null,
          facts: [
            { label: "المصدر والوردية", value: r.sourceReference },
            { label: "السبب", value: CASH_VARIANCE_REASON_LABELS[r.reasonCode as keyof typeof CASH_VARIANCE_REASON_LABELS] ?? r.reasonCode },
            { label: "المبلغ المتوقع", value: `${r.expectedAmount} د.ع` },
            { label: "المعدود فعلياً", value: `${r.actualAmount} د.ع` },
            { label: "الفارق النهائي", value: `${r.variance} د.ع` },
          ],
          smartNotice: {
            tone: shortage ? "warn" : "info",
            text: shortage
              ? "اعتماد عجز النقد يسجل فارقاً سالباً ويحمّل المسؤولية المالية للموظف أو حساب تسوية العجز."
              : "اعتماد زيادة النقد يثبت الفائض لصالح أرباح/تسويات الصندوق.",
          },
        };

        return buildRow(
          {
            kind: "cash.variance.approve",
            id: Number(r.id),
            title: `${shortage ? "عجز" : "زيادة"} نقد · ${r.sourceReference}`,
            subkind: CASH_VARIANCE_REASON_LABELS[r.reasonCode as keyof typeof CASH_VARIANCE_REASON_LABELS] ?? r.reasonCode,
            party: r.responsibleNameSnapshot,
            amount: String(Math.abs(Number(r.variance)).toFixed(2)),
            branchId: Number(r.branchId),
            branchName: names.get(Number(r.branchId)) ?? null,
            requestedBy: Number(r.proposedByUserId),
            requestedByName: people.get(Number(r.proposedByUserId)) ?? null,
            requestedAt: r.createdAt,
            summaryItems: [
              { label: "المتوقع", unitPrice: r.expectedAmount },
              { label: "المعدود فعلا", unitPrice: r.actualAmount },
              { label: `الدليل: ${r.evidenceReference}` },
            ],
            reason: r.reason,
            expectedVersion: r.version,
            rejectReason: "REQUIRED",
            reasonMinLength: 10,
            trigger: cashVarianceApprovalTrigger(shortage ? "SHORTAGE" : "SURPLUS", "APPROVE"),
            operationalContext,
          },
          scope.now,
        );
      });
  },
  async freshness(id) {
    const [row] = await requireDb().select({ id: cashVarianceCases.id }).from(cashVarianceCases).where(eq(cashVarianceCases.id, id)).limit(1);
    if (!row) return "GONE";
    // الحالةُ هي آخرُ حدث؛ الخدمة تقرؤها بالقفل التفاؤليّ — الطزاجةُ هنا وجودُ الحالة وحسب.
    return "PENDING";
  },
  async decide(input, actor) {
    const subject = `فرق النقد رقم ${input.id}`;
    const expectedVersion = input.expectedVersion ?? 0;
    if (input.action === "REJECT") {
      await rejectCashVarianceCase({ caseId: input.id, expectedVersion, clientRequestId: input.clientRequestId, reason: input.reason ?? "" }, serviceActor(actor));
      return decided(input, "REJECTED", defaultMessage("REJECTED", subject));
    }
    await approveCashVarianceCase({ caseId: input.id, expectedVersion, clientRequestId: input.clientRequestId, note: input.reason ?? null }, serviceActor(actor));
    return decided(input, "EXECUTED", defaultMessage("EXECUTED", subject));
  },
};

export const TREASURY_SOURCES: readonly DecisionSource[] = [voucherSource, expenseSource, accrualCorrectionSource, cashVarianceSource];
