/**
 * recordInvoiceEvent — الكاتبُ الوحيد لسجلّ `invoiceEvents` (مرآة recordWorkOrderEvent).
 *
 * الاستعمال (Slice 9، ٢٨/٨/٢٦): يُستدعى داخل `withTx` بجانب `logAuditTx` — dual-write
 * أثناء الفترة الانتقاليّة. الأنماط الحرِجة (`CREATED`/`PAID`/`CANCELLED`/`SUPERSEDED`)
 * تنادي كلتيهما.
 *
 * الحماية على مستوى القاعدة: `eventKey` UNIQUE يرفض الازدواج. المعالجة `ER_DUP_ENTRY`
 * كـidempotent replay (لا يُبطل المعاملة).
 */
import { invoiceEvents } from "../../drizzle/schema";
import type { Tx } from "../db";
import {
  buildInvoiceEventKey,
  type InvoiceEventType,
} from "@shared/invoiceEventType";
import { logger } from "../logger";

export interface RecordInvoiceEventInput {
  invoiceId: number;
  eventType: InvoiceEventType;
  fromStatus?: string | null;
  toStatus?: string | null;
  payload?: unknown;
  actorUserId?: number | null;
  branchId?: number | null;
  seq?: string | number | null;
}

export async function recordInvoiceEvent(
  tx: Tx,
  input: RecordInvoiceEventInput,
): Promise<void> {
  const eventKey = buildInvoiceEventKey(input.invoiceId, input.eventType, input.seq);
  try {
    await tx.insert(invoiceEvents).values({
      eventKey,
      invoiceId: input.invoiceId,
      eventType: input.eventType,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      payload: (input.payload as never) ?? null,
      actorUserId: input.actorUserId ?? null,
      branchId: input.branchId ?? null,
    });
  } catch (err) {
    // Drizzle يلفّ خطأ mysql2 — الشيفرة في `.code` أو `.cause.code` (مطابق workOrderEvents).
    const raw = err as { code?: string; cause?: { code?: string } } | null;
    const code = raw?.code ?? raw?.cause?.code;
    if (code === "ER_DUP_ENTRY") {
      logger.debug(
        { invoiceId: input.invoiceId, eventKey, eventType: input.eventType },
        "invoiceEvents: eventKey مكرَّرٌ (idempotent replay) — تُجوهل",
      );
      return;
    }
    throw err;
  }
}
