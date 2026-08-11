// جاهزية الإقفال الشهري (ش٥ من docs/double-entry-p2-plan-2026-08-11.md).
//
// حزمة الإقفال (`monthlyClosePack.ts`) تعرض ولا تُقفِل: لا شيء يمنع إقفال شهرٍ فيه ورديةٌ مفتوحة
// أو سندٌ معلَّق. هذه الوحدة تُنتج **قائمة الجاهزية** التي تحكم زرّ الإقفال.
//
// تصنيف المالك (١١/٨) — عقدٌ لا اجتهاد:
//   🔴 يحجب: وردياتٌ مفتوحة · سنداتٌ بانتظار الاعتماد.
//   🟡 تنبيهٌ فقط: جلسات جردٍ نشطة · طلبات تسوية مخزونٍ معلّقة · فجوات الدفتر المزدوج.
//
// **للقراءة فقط.** فرضُ الحجز مسؤولية `closeMonth` في الراوتر، ويُعيد استدعاء هذه الوحدة
// خادمياً تحت المعاملة — لا يُصدَّق ادّعاء الواجهة (وإلّا فتح طلبٌ مُلفَّقٌ بابَ الإقفال).
//
// **لماذا لا تشمل انحراف المطابقات:** دوالّ `reconcileService` غير مُنطَّقةٍ بشهرٍ ولا بفرع (تمسح
// كل الأطراف)، فإقحامُها في فحصٍ مُنطَّقٍ بهما يُنتج بنداً لا يعني ما يقوله. تُضاف في ش٤ حين
// تُنطَّق بحقّ عبر `reconcileDoubleEntry`.
import { and, eq, gte, inArray, isNotNull, lt, lte, sql, type SQL } from "drizzle-orm";
import {
  journalEntries,
  receipts,
  shifts,
  stockAdjustmentRequests,
  stocktakeSessions,
} from "../../../drizzle/schema";
import { getDb } from "../../db";

export type ReadinessStatus = "OK" | "BLOCK" | "WARN";

export interface ReadinessItem {
  key: string;
  label: string;
  /** OK حين العدّ صفر؛ وإلّا BLOCK أو WARN بحسب تصنيف المالك. */
  status: ReadinessStatus;
  count: number;
  detail: string;
}

export interface MonthCloseReadinessInput {
  /** الشهر بصيغة YYYY-MM. */
  month: string;
  /** فرعٌ بعينه، أو null لكل الفروع. */
  branchId?: number | null;
}

export interface MonthCloseReadinessResult {
  month: string;
  period: { from: string; to: string };
  /** هل يوجد بندٌ واحدٌ على الأقلّ حاجز؟ زرّ الإقفال يتبع هذه القيمة. */
  blocked: boolean;
  items: ReadinessItem[];
}

/** [أول الشهر، آخر يومه] — نفس منطق monthlyClosePack.monthRange (مصدر تاريخٍ واحد). */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/** اليوم التالي لـ`to` — الحدّ الأعلى الحصريّ لمقارنات timestamp (sargable، لا DATE() على العمود). */
function nextDay(to: string): string {
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function countOf(table: Parameters<NonNullable<ReturnType<typeof getDb>>["select"]> extends never ? never : any, where: SQL | undefined): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = await db.select({ n: sql<number>`COUNT(*)` }).from(table).where(where);
  return Number(rows[0]?.n ?? 0);
}

function mk(
  key: string,
  label: string,
  count: number,
  severity: Exclude<ReadinessStatus, "OK">,
  detail: string,
): ReadinessItem {
  return { key, label, count, status: count > 0 ? severity : "OK", detail: count > 0 ? detail : "لا شيء معلَّق" };
}

export async function getMonthCloseReadiness(
  input: MonthCloseReadinessInput,
): Promise<MonthCloseReadinessResult> {
  const { from, to } = monthRange(input.month);
  const branchId = input.branchId ?? null;
  const upper = nextDay(to);

  const withBranch = (col: SQL | undefined, branchCol: any): SQL | undefined =>
    branchId == null ? col : (and(col, eq(branchCol, branchId)) as SQL);

  const [openShifts, pendingVouchers, activeStocktakes, pendingAdjustments, ledgerGaps] =
    await Promise.all([
      // ورديةٌ ما زالت مفتوحةً وقد فُتحت في الشهر أو قبله ⇒ نقدُ الشهر لم يُعَدّ بعد.
      countOf(
        shifts,
        withBranch(and(eq(shifts.status, "OPEN"), lt(shifts.openedAt, new Date(`${upper}T00:00:00Z`))) as SQL, shifts.branchId),
      ),
      // سندٌ معلَّقٌ مؤرَّخٌ في الشهر أو قبله: اعتمادُه بعد القفل سيصطدم بـassertPeriodOpen فيتعذّر
      // اعتمادُه أبداً. لذلك يحجب — وقايةً لا تزيّناً. (المؤرَّخ بعد الشهر لا يُمَسّ.)
      countOf(
        receipts,
        withBranch(
          and(
            eq(receipts.approvalStatus, "PENDING_APPROVAL"),
            isNotNull(receipts.voucherNumber),
            sql`COALESCE(${receipts.voucherDate}, DATE(${receipts.createdAt})) <= ${to}`,
          ) as SQL,
          receipts.branchId,
        ),
      ),
      // جلسةٌ نشطةٌ الآن (لا تُنطَّق بتاريخ: النشِطة نشِطةٌ أياً كان شهر إنشائها).
      countOf(
        stocktakeSessions,
        withBranch(inArray(stocktakeSessions.status, ["COUNTING", "REVIEW"]) as SQL, stocktakeSessions.branchId),
      ),
      countOf(
        stockAdjustmentRequests,
        withBranch(eq(stockAdjustmentRequests.status, "PENDING_APPROVAL") as SQL, stockAdjustmentRequests.branchId),
      ),
      // أحداثٌ ماليّةٌ في الشهر لم يُرحَّل لها قيدٌ مزدوج (نوعٌ غير مُخطَّط أو دلو نقدٍ ملتبس).
      countOf(
        journalEntries,
        withBranch(
          // عمود DATE بنمط Date في drizzle ⇒ تُمرَّر كائنات Date لا نصوصاً.
          and(
            eq(journalEntries.status, "UNMAPPED"),
            gte(journalEntries.entryDate, new Date(`${from}T00:00:00Z`)),
            lte(journalEntries.entryDate, new Date(`${to}T00:00:00Z`)),
          ) as SQL,
          journalEntries.branchId,
        ),
      ),
    ]);

  const items: ReadinessItem[] = [
    mk("openShifts", "ورديات مفتوحة", openShifts, "BLOCK",
      `${openShifts} وردية ما زالت مفتوحة — أغلقها قبل الإقفال (نقدها لم يُعَدّ).`),
    mk("pendingVouchers", "سندات بانتظار الاعتماد", pendingVouchers, "BLOCK",
      `${pendingVouchers} سنداً معلَّقاً بتاريخٍ داخل الشهر أو قبله — اعتمادها بعد القفل يتعذّر.`),
    mk("activeStocktakes", "جلسات جرد نشطة", activeStocktakes, "WARN",
      `${activeStocktakes} جلسة جردٍ لم تُعتمَد بعد — لن تُحتسَب فروقُها في هذا الشهر.`),
    mk("pendingStockAdjustments", "طلبات تسوية مخزون معلّقة", pendingAdjustments, "WARN",
      `${pendingAdjustments} طلب تسويةٍ بانتظار الاعتماد.`),
    mk("ledgerGaps", "فجوات الدفتر المزدوج", ledgerGaps, "WARN",
      `${ledgerGaps} حدثاً ماليّاً بلا قيدٍ مزدوج في هذا الشهر (نوعٌ غير مُخطَّط بعد).`),
  ];

  return { month: input.month, period: { from, to }, blocked: items.some((i) => i.status === "BLOCK"), items };
}
