/* ============================================================================
 * طيّ البصمات الخام إلى سجل الحضور (server/services/hrDevices/attendanceFold.ts)
 * لكل (موظف × يوم): أول بصمة = دخول وآخرها = خروج، الساعات = الفارق، والكتابة عبر
 * recordAttendance القائمة (UPSERT على uq_att_employee_date بمصدر fingerprint) ⇒
 * سعر الساعة/الأجر/حراس منتهي الخدمة كلها من مسار واحد — لا منطق مالي مكرر هنا.
 * وصول بصمة متأخرة لنفس اليوم يعيد حساب اليوم كاملاً (لا يفسده).
 *
 * ضمانات حاسمة (فحصها تدقيق عدائي):
 *   - **لا يطمس تصحيحاً يدوياً:** يومٌ له سجل حضور بمصدر غير fingerprint (تصحيح مدير/إجازة)
 *     تُركن بصماته موسومةً ولا يُكتب فوقه — الجهاز يتبع للمدير لا العكس.
 *   - **الخطأ العابر لا يُفقِد يوماً:** فشل DB مؤقّت لا يوسم البصمة معالَجة (تُعاد المحاولة)؛
 *     فقط الأخطاء النهائية (منتهي خدمة/غير موجود) توسَم لتُستبعد نهائياً.
 *   - **لا تسقط طلبات الطيّ:** نداءٌ أثناء طيٍّ جارٍ يرفع علم إعادة تشغيل فيُعاد بعد الفراغ،
 *     والحلقة تستنزف كل المعلَّق دفعةً بعد دفعة (لا سقف يترك بقيةً غير مطويّة).
 * ========================================================================== */
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { attendance, employees, hrAttendancePunches } from "../../../drizzle/schema";
import { requireDb } from "../tx";
import { logger } from "../../logger";
import { recordAttendance } from "../attendanceService";
import { round2 } from "../money";

/** "YYYY-MM-DD HH:MM:SS" → ميلي ثانية (لاحقة Z ثابتة: فرق توقيتَي حائط لا يتأثر بالمنطقة). */
function wallMs(s: string): number {
  return new Date(`${s.replace(" ", "T")}Z`).getTime();
}

let folding = false;
let rerunRequested = false;

/** علامات أخطاء recordAttendance النهائية (يوسَم بها المعالَج نهائياً) — أيّ خطأ آخر عابر يُعاد. */
function isTerminalFoldError(msg: string): boolean {
  return msg.includes("منتهي الخدمة") || msg.includes("غير موجود") || msg.includes("سالبة");
}

/** طيّ دفعة واحدة (≤٥٠٠٠ بصمة معلَّقة مربوطة). يُعيد days/parked/processedAny للتحكّم بالحلقة. */
async function foldOneBatch(): Promise<{ days: number; parked: number; processedAny: boolean }> {
  const db = requireDb();
  const pending = await db
    .select({
      id: hrAttendancePunches.id,
      employeeId: hrAttendancePunches.employeeId,
      punchAt: hrAttendancePunches.punchAt,
    })
    .from(hrAttendancePunches)
    .where(and(isNull(hrAttendancePunches.processedAt), isNotNull(hrAttendancePunches.employeeId)))
    .orderBy(asc(hrAttendancePunches.punchAt))
    .limit(5000);
  if (pending.length === 0) return { days: 0, parked: 0, processedAny: false };

  // تجميع (موظف × يوم) — punchAt نص "YYYY-MM-DD HH:MM:SS" فاليوم = أول ١٠ خانات.
  const groups = new Map<string, { employeeId: number; date: string; ids: number[] }>();
  for (const p of pending) {
    const date = String(p.punchAt).slice(0, 10);
    const key = `${p.employeeId}|${date}`;
    const g = groups.get(key) ?? { employeeId: Number(p.employeeId), date, ids: [] };
    g.ids.push(p.id);
    groups.set(key, g);
  }

  let days = 0;
  let parked = 0;
  for (const g of Array.from(groups.values())) {
    // حارس التصحيح اليدوي: لا نطمس يوماً كتبه المدير (تصحيح/إجازة). نوسمه معالَجاً كي لا يعيد المحاولة.
    const [manual] = await db
      .select({ id: attendance.id })
      .from(attendance)
      .where(
        and(
          eq(attendance.employeeId, g.employeeId),
          eq(attendance.attendanceDate, g.date),
          ne(attendance.source, "fingerprint")
        )
      )
      .limit(1);
    if (manual) {
      await db
        .update(hrAttendancePunches)
        .set({ processedAt: sql`CURRENT_TIMESTAMP`, processNote: "يوجد إدخال يدوي لليوم — لم يُكتب فوقه" })
        .where(inArray(hrAttendancePunches.id, g.ids));
      parked++;
      continue;
    }

    // كل بصمات اليوم (معالجة وغير معالجة) — إعادة حساب اليوم كاملاً عند كل وصول جديد.
    const dayPunches = await db
      .select({ punchAt: hrAttendancePunches.punchAt })
      .from(hrAttendancePunches)
      .where(
        and(
          eq(hrAttendancePunches.employeeId, g.employeeId),
          sql`${hrAttendancePunches.punchAt} LIKE ${g.date + "%"}`
        )
      )
      .orderBy(asc(hrAttendancePunches.punchAt));
    const times = dayPunches.map((r) => String(r.punchAt));
    const first = times[0];
    const last = times[times.length - 1];
    const hours = times.length > 1 ? round2((wallMs(last) - wallMs(first)) / 3_600_000).toString() : "0";
    try {
      await recordAttendance({
        employeeId: g.employeeId,
        attendanceDate: g.date,
        hours,
        checkIn: first.slice(11, 16),
        checkOut: times.length > 1 ? last.slice(11, 16) : null,
        status: "PRESENT",
        source: "fingerprint",
        notes: null,
      });
      await db
        .update(hrAttendancePunches)
        .set({ processedAt: sql`CURRENT_TIMESTAMP`, processNote: null })
        .where(inArray(hrAttendancePunches.id, g.ids));
      days++;
    } catch (e) {
      const note = e instanceof Error ? e.message.slice(0, 200) : "تعذر الطي";
      if (isTerminalFoldError(note)) {
        // نهائيّ (منتهي خدمة/غير موجود): يوسَم فلا يعيد المحاولة عبثاً.
        await db
          .update(hrAttendancePunches)
          .set({ processedAt: sql`CURRENT_TIMESTAMP`, processNote: note })
          .where(inArray(hrAttendancePunches.id, g.ids));
        parked++;
        logger.warn({ employeeId: g.employeeId, date: g.date, note }, "hrDevices: بصمات مركونة نهائياً");
      } else {
        // عابر (قفل/اتصال DB): لا يوسَم — تُعاد المحاولة في الدورة التالية فلا يضيع يوم.
        logger.error({ employeeId: g.employeeId, date: g.date, note }, "hrDevices: خطأ عابر في الطيّ — سيُعاد");
      }
    }
  }
  return { days, parked, processedAny: true };
}

/**
 * معالجة كل المعلَّق حتى الاستنزاف. متسلسلة عبر علم `folding` (قفل منطقي)، ونداء أثناء الجريان
 * يرفع `rerunRequested` فيُعاد تشغيلها بعد الفراغ — لا يُسقط أيّ طلب طيّ.
 */
export async function processPendingFolds(): Promise<{ days: number; parked: number }> {
  if (folding) {
    rerunRequested = true;
    return { days: 0, parked: 0 };
  }
  folding = true;
  let days = 0;
  let parked = 0;
  try {
    do {
      rerunRequested = false;
      // استنزاف: كرّر ما دام هناك معلَّق (سقف أمان ضد حلقة لا تنتهي بخطأ عابر متكرّر).
      for (let guard = 0; guard < 1000; guard++) {
        const r = await foldOneBatch();
        days += r.days;
        parked += r.parked;
        // توقّف حين لا يوجد معلَّق أصلاً، أو حين لم يتقدّم شيء (كل المتبقّي عابر الخطأ) لتفادي الدوران.
        if (!r.processedAny || r.days + r.parked === 0) break;
      }
    } while (rerunRequested);
  } finally {
    folding = false;
  }
  return { days, parked };
}

/** تشغيل الطيّ في الخلفية بأمان (بعد كل دفعة استلام) — الفشل يُسجَّل ولا يُسقط المقبس. */
export function foldSoon(): void {
  void processPendingFolds().catch((e) => logger.error({ err: e }, "hrDevices: فشل الطيّ الخلفي"));
}
