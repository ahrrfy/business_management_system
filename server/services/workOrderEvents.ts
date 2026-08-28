/**
 * recordWorkOrderEvent — الكاتبُ الوحيد لسجلّ `workOrderEvents`.
 *
 * الاستعمال (Slice 6، ٢٨/٨/٢٦): يُستدعى داخل `withTx` بجانب `logAuditTx` — dual-write أثناء
 * الفترة الانتقاليّة. المسارات الحرِجة (start/markReady/deliver/cancel) تنادي كلتيهما فيبقى
 * `workOrderRouter.timeline` القائم (يقرأ auditLogs) صادقاً، ويبدأ `workOrderRouter.eventTimeline`
 * الجديد بجمع بياناتٍ منظَّمة قابلة للفلترة والفهرسة.
 *
 * الحماية على مستوى القاعدة: `eventKey` UNIQUE يرفض الازدواج — استدعاء مرّتين بنفس المفتاح
 * لنفس أمر الشغل يرمي (الخدمة تُبطل المعاملة كسائر أخطاء الإدراج). الأحداث الأحاديّة
 * (STARTED/MARKED_READY) لا تحتاج `seq` — المفتاح ثابتٌ للحدث الواحد.
 */
import { workOrderEvents } from "../../drizzle/schema";
import type { Tx } from "../db";
import {
  buildWorkOrderEventKey,
  type WorkOrderEventType,
} from "@shared/workOrderEventType";
import { logger } from "../logger";

export interface RecordWorkOrderEventInput {
  workOrderId: number;
  eventType: WorkOrderEventType;
  fromStatus?: string | null;
  toStatus?: string | null;
  payload?: unknown;
  actorUserId?: number | null;
  branchId?: number | null;
  /**
   * seq لِبناء eventKey للأحداث المتكرّرة (ASSIGNED/MATERIALS_UPDATED/…). الأحداث الأحاديّة
   * (STARTED/MARKED_READY/DELIVERED/CANCELLED) تتركه undefined — المفتاح ثابتٌ فيمنع
   * التكرار على مستوى القاعدة.
   */
  seq?: string | number | null;
}

export async function recordWorkOrderEvent(
  tx: Tx,
  input: RecordWorkOrderEventInput,
): Promise<void> {
  const eventKey = buildWorkOrderEventKey(input.workOrderId, input.eventType, input.seq);
  try {
    await tx.insert(workOrderEvents).values({
      eventKey,
      workOrderId: input.workOrderId,
      eventType: input.eventType,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      payload: (input.payload as never) ?? null,
      actorUserId: input.actorUserId ?? null,
      branchId: input.branchId ?? null,
    });
  } catch (err) {
    // ازدواجُ الـeventKey (ER_DUP_ENTRY) للأحداث الأحاديّة سيناريو مقبول أثناء retry تعاملي:
    // الاستدعاء الثاني يعني أنّ الأوّل نجح فعلاً. نُسجّل تنبيهاً ولا نرمي — الحفاظ على السلوك
    // idempotent (نفس المعنى الذي تُوفّره `checkIdempotency` في مسار البيع).
    const code = (err as { code?: string } | null)?.code;
    if (code === "ER_DUP_ENTRY") {
      logger.debug(
        { workOrderId: input.workOrderId, eventKey, eventType: input.eventType },
        "workOrderEvents: eventKey مكرَّرٌ (idempotent replay) — تُجوهل",
      );
      return;
    }
    throw err;
  }
}
