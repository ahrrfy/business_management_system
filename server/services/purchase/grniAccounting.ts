import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  accountingEntries,
  goodsReceiptAccountingLinks,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { createPostingIntent, creditLine, debitLine } from "../accounting/postingEngine";
import { postEntry } from "../ledgerService";
import { money, round2, toDbMoney } from "../money";

export function stableCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableCanonical(row[key])}`)
    .join(",")}}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function varianceLines(
  difference: Decimal,
): {
  debits: ReturnType<typeof debitLine>[];
  credits: ReturnType<typeof creditLine>[];
  roleDebits: Record<string, Decimal>;
  roleCredits: Record<string, Decimal>;
} {
  if (difference.gt(0)) {
    return {
      debits: [debitLine("PURCHASE_PRICE_VARIANCE", difference)],
      credits: [],
      roleDebits: { PURCHASE_PRICE_VARIANCE: difference },
      roleCredits: {},
    };
  }
  if (difference.lt(0)) {
    const absolute = difference.abs();
    return {
      debits: [],
      credits: [creditLine("PURCHASE_PRICE_VARIANCE", absolute)],
      roleDebits: {},
      roleCredits: { PURCHASE_PRICE_VARIANCE: absolute },
    };
  }
  return { debits: [], credits: [], roleDebits: {}, roleCredits: {} };
}

async function entryIdByDedupe(tx: Tx, dedupeKey: string): Promise<number> {
  const row = (
    await tx
      .select({ id: accountingEntries.id })
      .from(accountingEntries)
      .where(eq(accountingEntries.dedupeKey, dedupeKey))
      .limit(1)
  )[0];
  if (!row) throw new Error(`accounting entry missing for ${dedupeKey}`);
  return Number(row.id);
}

export async function postGoodsReceiptGrniTx(
  tx: Tx,
  input: {
    goodsReceiptId: number;
    purchaseOrderId: number;
    supplierId: number;
    branchId: number;
    inventoryAmount: Decimal;
    totalAmount: Decimal;
    actorId: number;
  },
): Promise<number> {
  const inventoryAmount = round2(input.inventoryAmount);
  const totalAmount = round2(input.totalAmount);
  const taxComponent = totalAmount.minus(inventoryAmount);
  // VAT is zero by policy. Until a dedicated recoverable-tax asset is modeled,
  // a non-zero tax component must not be hidden inside inventory or GRNI.
  if (!taxComponent.isZero()) {
    throw new Error("GRNI receipt posting requires zero tax under the current Iraq tax policy");
  }
  const dedupeKey = `GRNI:RECEIPT:${input.goodsReceiptId}`;
  const source = {
    roleDebits: { INVENTORY: inventoryAmount },
    roleCredits: { GRNI: totalAmount },
  };
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: input.branchId,
    purchaseOrderId: input.purchaseOrderId,
    supplierId: input.supplierId,
    amount: totalAmount,
    cost: inventoryAmount,
    createdBy: input.actorId,
    dedupeKey,
    notes: `إثبات إذن استلام مخزني ${input.goodsReceiptId} مقابل GRNI`,
    postingIntent: createPostingIntent(
      "PURCHASE_GRNI_RECEIPT",
      "ADJUST",
      [debitLine("INVENTORY", inventoryAmount), creditLine("GRNI", totalAmount)],
      source,
    ),
    postingSourceComponents: source,
  });
  const accountingEntryId = await entryIdByDedupe(tx, dedupeKey);
  await tx.insert(goodsReceiptAccountingLinks).values({
    linkKey: dedupeKey,
    goodsReceiptId: input.goodsReceiptId,
    reversalId: null,
    accountingEntryId,
    linkType: "GRNI_RECOGNITION",
    amount: toDbMoney(totalAmount),
  });
  return accountingEntryId;
}

export async function postGoodsReceiptReversalTx(
  tx: Tx,
  input: {
    goodsReceiptId: number;
    reversalId: number;
    purchaseOrderId: number;
    supplierId: number;
    branchId: number;
    grniAmount: Decimal;
    inventoryCarryingAmount: Decimal;
    actorId: number;
  },
): Promise<number> {
  const grniAmount = round2(input.grniAmount);
  const inventory = round2(input.inventoryCarryingAmount);
  const variance = varianceLines(inventory.minus(grniAmount));
  const dedupeKey = `GRNI:RECEIPT_REVERSAL:${input.reversalId}`;
  const source = {
    roleDebits: { GRNI: grniAmount, ...variance.roleDebits },
    roleCredits: { INVENTORY: inventory, ...variance.roleCredits },
  };
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: input.branchId,
    purchaseOrderId: input.purchaseOrderId,
    supplierId: input.supplierId,
    amount: grniAmount,
    cost: inventory,
    createdBy: input.actorId,
    dedupeKey,
    notes: `عكس إذن استلام ${input.goodsReceiptId} بالمستند ${input.reversalId}`,
    postingIntent: createPostingIntent(
      "PURCHASE_GRNI_RECEIPT_REVERSAL",
      "ADJUST",
      [
        debitLine("GRNI", grniAmount),
        ...variance.debits,
        creditLine("INVENTORY", inventory),
        ...variance.credits,
      ],
      source,
    ),
    postingSourceComponents: source,
  });
  const accountingEntryId = await entryIdByDedupe(tx, dedupeKey);
  await tx.insert(goodsReceiptAccountingLinks).values({
    linkKey: dedupeKey,
    goodsReceiptId: input.goodsReceiptId,
    reversalId: input.reversalId,
    accountingEntryId,
    linkType: "GRNI_REVERSAL",
    amount: toDbMoney(grniAmount),
  });
  return accountingEntryId;
}

export async function postSupplierInvoiceGrniTx(
  tx: Tx,
  input: {
    supplierInvoiceId: number;
    purchaseOrderId: number | null;
    supplierId: number;
    branchId: number;
    invoiceAmount: Decimal;
    taxAmount: Decimal;
    grniAmount: Decimal;
    actorId: number;
    reversal?: boolean;
  },
): Promise<number> {
  const invoiceAmount = round2(input.invoiceAmount);
  const taxAmount = round2(input.taxAmount);
  const grniAmount = round2(input.grniAmount);
  if (taxAmount.isNegative() || taxAmount.gt(invoiceAmount)) throw new Error("supplier invoice tax amount is outside invoice total");
  const forwardVariance = invoiceAmount.minus(taxAmount).minus(grniAmount);
  const difference = input.reversal ? forwardVariance.negated() : forwardVariance;
  const variance = varianceLines(difference);
  const dedupeKey = input.reversal
    ? `GRNI:SUPPLIER_INVOICE_REVERSAL:${input.supplierInvoiceId}`
    : `GRNI:SUPPLIER_INVOICE:${input.supplierInvoiceId}`;
  const source = input.reversal
    ? {
        roleDebits: { AP: invoiceAmount, ...variance.roleDebits },
        roleCredits: { GRNI: grniAmount, ...(taxAmount.isZero() ? {} : { TAX_PAYABLE: taxAmount }), ...variance.roleCredits },
      }
    : {
        roleDebits: { GRNI: grniAmount, ...(taxAmount.isZero() ? {} : { TAX_PAYABLE: taxAmount }), ...variance.roleDebits },
        roleCredits: { AP: invoiceAmount, ...variance.roleCredits },
      };
  const lines = input.reversal
    ? [
        debitLine("AP", invoiceAmount),
        ...variance.debits,
        creditLine("GRNI", grniAmount),
        ...(taxAmount.isZero() ? [] : [creditLine("TAX_PAYABLE", taxAmount)]),
        ...variance.credits,
      ]
    : [
        debitLine("GRNI", grniAmount),
        ...(taxAmount.isZero() ? [] : [debitLine("TAX_PAYABLE", taxAmount)]),
        ...variance.debits,
        creditLine("AP", invoiceAmount),
        ...variance.credits,
      ];
  await postEntry(tx, {
    entryType: "ADJUST",
    branchId: input.branchId,
    purchaseOrderId: input.purchaseOrderId,
    supplierId: input.supplierId,
    amount: invoiceAmount,
    cost: grniAmount,
    taxAmount: input.reversal ? taxAmount.negated() : taxAmount,
    createdBy: input.actorId,
    dedupeKey,
    notes: input.reversal
      ? `عكس فاتورة مورد ${input.supplierInvoiceId} وإعادة GRNI`
      : `ترحيل فاتورة مورد ${input.supplierInvoiceId} وتصفية GRNI`,
    postingIntent: createPostingIntent(
      input.reversal ? "SUPPLIER_INVOICE_GRNI_REVERSAL" : "SUPPLIER_INVOICE_GRNI",
      "ADJUST",
      lines,
      source,
    ),
    postingSourceComponents: source,
  });
  return entryIdByDedupe(tx, dedupeKey);
}

export function asMoney(value: unknown): Decimal {
  return money(String(value ?? "0"));
}
