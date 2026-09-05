/**
 * ═══ عكسُ فاتورة البيع عبر المحرّك — المدخلُ الواحد للإلغاء والمرتجع الكامل ═══
 *
 * الخدمةُ المستدعية (`sale/cancel.ts` · `returnService.ts`) تبقي حرّاسَها (الفترة · الفرع ·
 * فصل المهام · الإرسالية · الأقساط · الكروت) وقفلَ مصدر النقد وحالةَ المستند؛ وتُفوّض **الأثرَ
 * الماليّ والمخزنيّ كلَّه** إلى هنا: تجسيدٌ من الحقيقة ⇒ `reverse()` بمنفّذي الفاتورة ⇒ ملخّصٌ
 * بما رُدّ وما بقي مفتوحاً.
 *
 * ما لا يُقرَّر هنا: الرافدُ (يصل في `refund`)، ومصيرُ البضاعة (`restock`)، وحالةُ الفاتورة
 * بعد العكس (CANCELLED/RETURNED — تكتبها الخدمة لأنّها دلالةُ المستند لا أثرٌ ماليّ).
 */
import type Decimal from "decimal.js";

import type { ReversalScope } from "@shared/documentEffects";

import type { Tx } from "../../db";
import { reverse, type OpenEffectReport } from "../reversalEngine";
import type { Actor } from "../tx";
import { DEFAULT_EXECUTORS } from "./registry";
import { invoiceInventoryExecutor } from "./executors/invoiceInventory";
import {
  invoiceConsignmentExecutor,
  invoiceGiftExecutor,
  invoiceRoundingExecutor,
  invoiceSaleLedgerExecutor,
} from "./executors/invoiceLedger";
import { invoiceRefundExecutor } from "./executors/invoiceRefund";
import { invoiceContext, readLedgerState } from "./executors/invoiceState";
import { readRefundState } from "./executors/refundState";
import { INVOICE_SALE_SCOPE, materializeInvoiceEffects } from "./materialize/invoice";
import type { ExecutorRegistry, RefundDecision, ReversalRun } from "./types";
import { money } from "../money";

/** منفّذو فاتورة البيع — يعلون على السجلّ العامّ حيث يختلف القيدُ بحسب المستند. */
export const INVOICE_EXECUTORS: ExecutorRegistry = {
  ...DEFAULT_EXECUTORS,
  INVENTORY: invoiceInventoryExecutor,
  CONSIGNMENT: invoiceConsignmentExecutor,
  LEDGER_ENTRY: invoiceSaleLedgerExecutor,
  GIFT: invoiceGiftExecutor,
  ROUNDING: invoiceRoundingExecutor,
  PAID_AMOUNT: invoiceRefundExecutor,
};

export const INVOICE_SALE_REVERSAL_SCOPE: ReversalScope = { kind: "ALL", operationScopes: [INVOICE_SALE_SCOPE] };

export interface ReverseInvoiceSaleInput {
  invoiceId: number;
  flavor: "CANCEL" | "RETURN";
  /** سببُ العكس الموثَّق في سجلّ الأثر (إلزاميّ). */
  reason: string;
  /** نصٌّ حرٌّ يدخل نصوص القيود (اختياريّ). */
  reasonNote?: string | null;
  /** مصيرُ البضاعة — الافتراض: تعود للرفّ. */
  restock?: boolean;
  /** قرارُ ردّ المال — `null` حين لا يُردّ شيء (يُرفَض إن كان ثمّة مقبوضٌ يُردّ). */
  refund?: RefundDecision | null;
}

export interface ReverseInvoiceSaleSummary {
  /** المتبقّي الدفتريّ الذي عُكس الآن (قيد SALE − Σ RETURN — أساسٌ خامٌّ قبل تقريب IQD). */
  remainingAmount: Decimal;
  /** المتبقّي **المستنديّ** (`total − returnedTotal` قبل العكس) — أساسُ `returnedTotal` والذمّة. */
  remainingDocumentTotal: Decimal;
  remainingRevenue: Decimal;
  remainingTax: Decimal;
  /** ما خرج فعلاً الآن للزبون. */
  refundAmount: Decimal;
  /** ما بقي سندَ صرفٍ معلَّقاً باعتماد المالك. */
  pendingRefundAmount: Decimal;
  pendingRefundVoucherNumber: string | null;
  refundReceiptId: number | null;
  leftOpen: OpenEffectReport[];
  reversedEffectIds: number[];
}

export async function reverseInvoiceSaleInTx(
  tx: Tx,
  input: ReverseInvoiceSaleInput,
  actor: Actor,
): Promise<ReverseInvoiceSaleSummary> {
  const state = new Map<string, unknown>();
  const decisions = {
    flavor: input.flavor,
    reasonNote: input.reasonNote ?? null,
    restock: input.restock !== false,
    refund: input.refund ?? null,
  };
  const run: ReversalRun = {
    documentType: "INVOICE",
    documentId: input.invoiceId,
    reason: input.reason,
    actor,
    decisions,
    state,
  };
  const before = (await invoiceContext(tx, run)).invoice;
  const remainingDocumentTotal = money(before.total).minus(money(before.returnedTotal ?? "0"));
  await materializeInvoiceEffects(tx, run);
  const result = await reverse(tx, "INVOICE", input.invoiceId, INVOICE_SALE_REVERSAL_SCOPE, input.reason, actor, {
    mode: "EXECUTE",
    executors: INVOICE_EXECUTORS,
    decisions,
    state,
  });
  const ledger = readLedgerState(result.run);
  const refund = readRefundState(result.run);
  return {
    remainingAmount: ledger?.remainingAmount ?? money(0),
    remainingDocumentTotal,
    remainingRevenue: ledger?.remainingRevenue ?? money(0),
    remainingTax: ledger?.remainingTax ?? money(0),
    refundAmount: refund.materialized,
    pendingRefundAmount: refund.deferred?.amount ?? money(0),
    pendingRefundVoucherNumber: refund.pendingVoucherNumber,
    refundReceiptId: refund.refundReceiptId,
    leftOpen: result.leftOpen,
    reversedEffectIds: result.reversedEffectIds,
  };
}
