import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export interface CashEventAtColumns {
  approvedBy: SQLWrapper;
  createdBy: SQLWrapper;
  approvedAt: SQLWrapper;
  createdAt: SQLWrapper;
}

/**
 * لحظة تحقّق الحركة النقدية:
 * - مسار maker-checker يتحقق عند اعتماد التنفيذ فعلياً (بصرف النظر عن هوية المعتمِد —
 *   ⭐ قرار المالك ٣/٩/٢٦ يجيز اعتماد المالك حركته بنفسه، فمساواةُ المعتمِد بالمُنشئ لم تعد
 *   دليلاً على أنّ الاعتماد لم يقع؛ المصدر الوحيد لوقوعه هو `approvedAt` نفسها).
 * - الحركة الفورية، أو الصف الذي لا يملك دليلاً كاملاً للاعتماد، يبقى بتاريخ إنشائه.
 *
 * هذا هو تعريف المصدر الواحد للأدلة اليومية، وجاهزية الإقفال الشهري، وتقارير النقد.
 */
export function cashEventAtSql(columns: CashEventAtColumns): SQL {
  return sql`CASE
    WHEN ${columns.approvedBy} IS NOT NULL
      AND ${columns.approvedAt} IS NOT NULL
      THEN ${columns.approvedAt}
    ELSE ${columns.createdAt}
  END`;
}

/** يبني التعريف نفسه لاستعلامات SQL الخام التي تستخدم alias لجدول receipts. */
export function receiptCashEventAtSql(alias = "r"): SQL {
  const table = sql.identifier(alias);
  const column = (name: string) => sql`${table}.${sql.identifier(name)}`;
  return cashEventAtSql({
    approvedBy: column("approvedBy"),
    createdBy: column("createdBy"),
    approvedAt: column("approvedAt"),
    createdAt: column("createdAt"),
  });
}
