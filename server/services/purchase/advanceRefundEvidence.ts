import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditLogs, receipts } from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { money } from "../money";
import { sha256, stableCanonical } from "./grniAccounting";
import { logAuditTx, redactAuditValue } from "../auditService";
import type { Actor } from "../tx";
import {
  isOwnedSupplierIncoming,
  isOwnedVoucherCancellation,
} from "./advanceRefundOwnership";

export const ADVANCE_REFUND_ACTION = "supplier.advanceRefund.post";
export const ADVANCE_REFUND_RESTORE_ACTION = "supplier.advanceRefund.restore";
export const ADVANCE_REFUND_FRAGMENT_ACTION = "supplier.advanceRefund.fragment";
const FORMAT = "supplierAdvanceRefund.fragments.v1";
const MAX_FRAGMENTS = 4096;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const headerSchema = z
  .object({
    version: z.literal(1),
    sourceId: z.number().int().positive(),
    sourceReceiptId: z.number().int().positive(),
    supplierId: z.number().int().positive(),
    branchId: z.number().int().positive(),
    amount: z.string().regex(/^\d+\.\d{2}$/),
  })
  .strict();
const evidenceSchema = headerSchema
  .extend({
    allocations: z.array(
      z
        .object({
          id: z.number().int().positive(),
          amount: z.string().regex(/^\d+\.\d{2}$/),
        })
        .strict(),
    ),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal(FORMAT),
    data: headerSchema,
    hash: hashSchema,
    digest: hashSchema,
    count: z.number().int().min(1).max(MAX_FRAGMENTS),
    encoding: z.literal("base64-json"),
    manifestHash: hashSchema,
  })
  .strict();
const fragmentSchema = z
  .object({
    format: z.literal(FORMAT),
    receiptId: z.number().int().positive(),
    manifestHash: hashSchema,
    index: z
      .number()
      .int()
      .min(0)
      .max(MAX_FRAGMENTS - 1),
    count: z.number().int().min(1).max(MAX_FRAGMENTS),
    fragmentHash: hashSchema,
    data: z.string().min(1).max(800),
  })
  .strict();
export type AdvanceRefundEvidence = {
  version: 1;
  sourceId: number;
  sourceReceiptId: number;
  supplierId: number;
  branchId: number;
  amount: string;
  allocations: { id: number; amount: string }[];
};
export function advanceRefundError(why: string): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تعذر إتمام استرداد دفعة المورد",
      why,
      doThis:
        "حدد سند الصرف الأصلي من دفعات المورد القابلة للاسترداد؛ راجع الروابط والمبالغ قبل إعادة المحاولة",
    }),
  });
}
export async function readAdvanceRefundEvidence(
  db: DB | Tx,
  receiptId: number,
): Promise<AdvanceRefundEvidence | null> {
  const rows = await db
    .select({ action: auditLogs.action, value: auditLogs.newValue })
    .from(auditLogs)
    .where(
      and(
        inArray(auditLogs.action, [
          ADVANCE_REFUND_ACTION,
          ADVANCE_REFUND_FRAGMENT_ACTION,
        ]),
        eq(auditLogs.entityType, "receipt"),
        eq(auditLogs.entityId, String(receiptId)),
      ),
    )
    .limit(MAX_FRAGMENTS + 2);
  if (!rows.length) return null;
  const heads = rows.filter((row) => row.action === ADVANCE_REFUND_ACTION);
  const fragments = rows.filter(
    (row) => row.action === ADVANCE_REFUND_FRAGMENT_ACTION,
  );
  if (heads.length !== 1 || rows.length > MAX_FRAGMENTS + 1)
    advanceRefundError("رأس دليل الاسترداد أو أجزاؤه غير مكتملة");
  const envelope = heads[0].value as {
    data?: AdvanceRefundEvidence;
    hash?: string;
    format?: string;
  } | null;
  if (envelope?.format === FORMAT) {
    const parsed = manifestSchema.safeParse(envelope);
    if (!parsed.success) advanceRefundError("رأس دليل الاسترداد غير صالح");
    const { manifestHash, ...head } = parsed.data;
    if (
      sha256(stableCanonical(head)) !== manifestHash ||
      fragments.length !== head.count
    )
      advanceRefundError("بصمة رأس الاسترداد أو عدد أجزائه غير مطابق");
    const parts = fragments
      .map((row) => {
        const part = fragmentSchema.safeParse(row.value);
        if (
          !part.success ||
          part.data.receiptId !== receiptId ||
          part.data.count !== head.count ||
          part.data.manifestHash !== manifestHash ||
          sha256(part.data.data) !== part.data.fragmentHash
        )
          advanceRefundError("جزء من دليل الاسترداد لا يطابق بصمته");
        return part.data;
      })
      .sort((a, b) => a.index - b.index);
    if (parts.some((part, index) => part.index !== index))
      advanceRefundError("ترتيب أجزاء دليل الاسترداد غير مطابق");
    const encoded = parts.map((part) => part.data).join("");
    const bytes = Buffer.from(encoded, "base64");
    if (sha256(encoded) !== head.digest || bytes.toString("base64") !== encoded)
      advanceRefundError("بصمة وثيقة الاسترداد المجمعة غير مطابقة");
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      advanceRefundError("وثيقة الاسترداد المجمعة غير قابلة للقراءة");
    }
    const document = evidenceSchema.safeParse(value);
    if (
      !document.success ||
      sha256(stableCanonical(document.data)) !== head.hash
    )
      advanceRefundError("وثيقة الاسترداد لا تطابق بصمتها");
    const { allocations: _allocations, ...savedHeader } = document.data;
    if (stableCanonical(savedHeader) !== stableCanonical(head.data))
      advanceRefundError("هوية وثيقة الاسترداد لا تطابق رأسها");
    return document.data;
  }
  if (
    fragments.length !== 0 ||
    !envelope?.data ||
    envelope.data.version !== 1 ||
    sha256(stableCanonical(envelope.data)) !== envelope.hash
  )
    advanceRefundError("بصمة ربط الاسترداد غير صالحة");
  return envelope.data;
}

export async function writeAdvanceRefundEvidence(
  tx: Tx,
  receiptId: number,
  data: AdvanceRefundEvidence,
  actor: Actor,
) {
  const checked = evidenceSchema.parse(data);
  const encoded = Buffer.from(stableCanonical(checked), "utf8").toString(
    "base64",
  );
  const count = Math.ceil(encoded.length / 800);
  if (count > MAX_FRAGMENTS)
    advanceRefundError("حجم دليل الاسترداد يتجاوز حد الأجزاء الآمن");
  const { allocations: _allocations, ...header } = checked;
  const head = {
    format: FORMAT,
    data: header,
    hash: sha256(stableCanonical(checked)),
    digest: sha256(encoded),
    count,
    encoding: "base64-json",
  };
  const manifestHash = sha256(stableCanonical(head));
  const manifest = { ...head, manifestHash };
  const parts = Array.from({ length: count }, (_, index) => {
    const part = encoded.slice(index * 800, (index + 1) * 800);
    return {
      format: FORMAT,
      receiptId,
      manifestHash,
      count,
      index,
      fragmentHash: sha256(part),
      data: part,
    };
  });
  for (const value of [manifest, ...parts]) {
    if (stableCanonical(redactAuditValue(value)) !== stableCanonical(value))
      advanceRefundError("حدود تخزين دليل الاسترداد لا تحفظ محتواه كاملاً");
  }
  for (const part of parts)
    await logAuditTx(tx, actor, {
      action: ADVANCE_REFUND_FRAGMENT_ACTION,
      entityType: "receipt",
      entityId: receiptId,
      newValue: part,
    });
  await logAuditTx(tx, actor, {
    action: ADVANCE_REFUND_ACTION,
    entityType: "receipt",
    entityId: receiptId,
    newValue: manifest,
  });
}

/** IDs only: callers retain their existing voucher visibility and cost redaction. */
export async function loadSupplierAdvanceRefundLinks(
  db: DB | Tx,
  receiptId: number,
) {
  const bound = await readAdvanceRefundEvidence(db, receiptId);
  const [receipt] = await db
    .select({ reference: receipts.referenceNumber })
    .from(receipts)
    .where(eq(receipts.id, receiptId))
    .limit(1);
  const cancellationOriginalId = /^CANCEL-VCH-(\d+)$/.exec(
    receipt?.reference ?? "",
  )?.[1];
  const cancelled = cancellationOriginalId
    ? await readAdvanceRefundEvidence(db, Number(cancellationOriginalId))
    : null;
  if (bound || cancelled)
    return {
      kind: bound
        ? ("ADVANCE_REFUND" as const)
        : ("ADVANCE_REFUND_CANCELLATION" as const),
      sourceReceiptId: (bound ?? cancelled)!.sourceReceiptId,
      refundedReceiptId: bound ? receiptId : Number(cancellationOriginalId),
      refundReceiptIds: [] as number[],
      cancellationReceiptIds: [] as number[],
    };
  const markers = await db
    .select({ receiptId: auditLogs.entityId, value: auditLogs.newValue })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, ADVANCE_REFUND_ACTION),
        eq(auditLogs.entityType, "receipt"),
        sql`JSON_EXTRACT(${auditLogs.newValue}, '$.data.sourceReceiptId') = ${receiptId}`,
      ),
    )
    .limit(501);
  if (!markers.length) return null;
  if (markers.length > 500)
    advanceRefundError("تجاوز عدد روابط الاسترداد حد المراجعة الآمنة");
  const refundReceiptIds: number[] = [];
  for (const row of markers) {
    const id = Number(row.receiptId);
    const value = Number.isSafeInteger(id)
      ? await readAdvanceRefundEvidence(db, id)
      : null;
    if (!value || value.sourceReceiptId !== receiptId)
      advanceRefundError("بصمة رابط الاسترداد غير صالحة");
    refundReceiptIds.push(id);
  }
  const cancelledReceipts = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        inArray(
          receipts.referenceNumber,
          refundReceiptIds.map((id) => `CANCEL-VCH-${id}`),
        ),
        eq(receipts.approvalStatus, "APPROVED"),
        eq(receipts.status, "COMPLETED"),
      ),
    );
  return {
    kind: "ADVANCE_SOURCE" as const,
    sourceReceiptId: receiptId,
    refundedReceiptId: null,
    refundReceiptIds,
    cancellationReceiptIds: cancelledReceipts.map((row) => row.id),
  };
}

/** Never guess which original OUT an old, unbound supplier IN refunded. */
export async function assertSupplierAdvanceInboundHistory(
  db: DB | Tx,
  supplierId: number,
  _branchId: number,
) {
  const incoming = await db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.partyType, "SUPPLIER"),
        eq(receipts.partyId, supplierId),
        eq(receipts.direction, "IN"),
        eq(receipts.approvalStatus, "APPROVED"),
        inArray(receipts.status, ["COMPLETED", "REVERSED"]),
      ),
    )
    .limit(501);
  if (incoming.length > 500)
    advanceRefundError("تجاوز سجل قبض المورد حد المراجعة الآمنة");
  for (const receipt of incoming) {
    const bound = await readAdvanceRefundEvidence(db, receipt.id);
    if (
      bound &&
      bound.supplierId === supplierId &&
      bound.branchId === receipt.branchId &&
      money(bound.amount).eq(receipt.amount)
    )
      continue;
    if (await isOwnedSupplierIncoming(db, receipt)) continue;
    const cancellationId = /^CANCEL-VCH-(\d+)$/.exec(
      receipt.referenceNumber ?? "",
    )?.[1];
    if (cancellationId) {
      const [original] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, Number(cancellationId)))
        .limit(1);
      if (
        original?.direction === "OUT" &&
        (await isOwnedVoucherCancellation(db, original, receipt))
      )
        continue;
    }
    if (receipt.status === "REVERSED") {
      const [undo] = await db
        .select()
        .from(receipts)
        .where(
          and(
            eq(receipts.referenceNumber, `CANCEL-VCH-${receipt.id}`),
            eq(receipts.direction, "OUT"),
            eq(receipts.approvalStatus, "APPROVED"),
            eq(receipts.status, "COMPLETED"),
          ),
        )
        .limit(1);
      if (undo && (await isOwnedVoucherCancellation(db, receipt, undo)))
        continue;
    }
    advanceRefundError(
      `يوجد سند قبض مورد غير مربوط بمصدره (#${receipt.id})؛ رصيد الدفعة السابقة غير قابل للإثبات`,
    );
  }
}
