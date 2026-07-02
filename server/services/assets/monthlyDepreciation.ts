// FI-02 الإهلاك الشهري: يُرحّل إهلاك شهرٍ واحد لكل أصل غير مُستبعَد (نهج catch-up + idempotent).
import Decimal from "decimal.js";
import { eq, ne } from "drizzle-orm";
import { fixedAssets } from "../../../drizzle/schema";
import { postEntry } from "../ledgerService";
import { money, toDbMoney } from "../money";
import { type Actor, requireDb, withTx } from "../tx";
import { computeDepreciation } from "./depreciation";
import { loadForUpdate } from "./helpers";
import { isDupEntry } from "@shared/errorMap.ar";

export interface DepreciationRunResult {
  period: string; // YYYY-MM
  assetsPosted: number;
  totalDepreciation: string;
}

/**
 * FI-02 (تدقيق ٢٠/٦، قرار المالك «إهلاك شهريّ عبر مهمة دورية»): يُرحّل إهلاك شهرٍ واحد لكل أصل
 * غير مُستبعَد كقيد مصروف في الدفتر، ويُحدّث الإهلاك المتراكم على الأصل (⇒ الميزانية NBV).
 * **نهج catch-up:** monthDep = computeDepreciation(نهاية الشهر).accumulated − المتراكم المخزَّن ⇒
 * المُرحَّل يُطابق التحليليّ تماماً فلا انحراف عند التصرّف (FA-02)، ويُعالج أيّ شهر فائت تلقائياً.
 * **idempotent:** القفل FOR UPDATE يُسلسِل + الحارس monthDep≤0 يَتخطّى المُكتمِل/المستقبليّ +
 * dedupeKey DEPR:<id>:<YYYY-MM> فريد ⇒ إعادة التشغيل لا تُكرّر القيد ولا المتراكم.
 */
export async function postMonthlyDepreciation(year: number, month: number, actor: Actor): Promise<DepreciationRunResult> {
  const period = `${year}-${String(month).padStart(2, "0")}`;
  // asOf = نهاية الشهر (أوّل لحظة من الشهر التالي ⇒ يَشمل كامل إهلاك الشهر) لاحتساب المتراكم.
  // entryDate = آخر يوم في الشهر (Date.UTC صفر-أساس ⇒ يوم 0 من month١-١٢) ليَقع القيد ضمن شهره في P&L.
  const asOf = new Date(Date.UTC(year, month, 1));
  const entryDate = new Date(Date.UTC(year, month, 0));
  const db = requireDb();
  const rows = await db.select({ id: fixedAssets.id }).from(fixedAssets).where(ne(fixedAssets.status, "disposed"));

  let posted = 0;
  let total = new Decimal(0);
  for (const { id } of rows) {
    const dep = await withTx(async (tx) => {
      const a = await loadForUpdate(tx, id);
      if (a.status === "disposed") return new Decimal(0);
      const target = money(
        computeDepreciation(
          {
            purchaseValue: a.purchaseValue,
            salvageValue: a.salvageValue ?? "0",
            usefulLifeYears: a.usefulLifeYears,
            depreciationMethod: (a.depreciationMethod as "sl" | "db") ?? "sl",
            purchaseDate: a.purchaseDate as unknown as string,
            status: a.status,
          },
          asOf,
        ).accumulated,
      );
      const stored = money(a.accumulatedDepreciation ?? "0");
      const monthDep = target.sub(stored);
      if (monthDep.lte(0)) return new Decimal(0); // مُكتمِل الإهلاك أو قبل تاريخ الشراء
      await postEntry(tx, {
        entryType: "ADJUST",
        branchId: a.branchId != null ? Number(a.branchId) : actor.branchId || null,
        cost: monthDep,
        profit: monthDep.neg(), // مصروف: revenue(0) − cost = ربح سالب ⇒ يَجتاز reconcileLedgerProfit
        amount: monthDep,
        entryDate,
        dedupeKey: `DEPR:${id}:${period}`,
        notes: `إهلاك ${period} لأصل ${a.code}`,
      });
      await tx
        .update(fixedAssets)
        .set({ accumulatedDepreciation: toDbMoney(stored.add(monthDep)) })
        .where(eq(fixedAssets.id, id));
      return monthDep;
    }).catch((e: any) => {
      // idempotency ثانوي: الشهر مُرحَّل سابقاً ⇒ القيد الفريد على dedupeKey يَرفض ⇒ تخطٍّ آمن.
      if (isDupEntry(e)) return new Decimal(0);
      throw e;
    });
    if (dep.gt(0)) {
      posted++;
      total = total.add(dep);
    }
  }
  return { period, assetsPosted: posted, totalDepreciation: toDbMoney(total) };
}
