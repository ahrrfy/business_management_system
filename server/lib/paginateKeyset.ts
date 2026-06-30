// Keyset pagination helper — يَستبدِل ~٢١٠ سطر مُكرَّر عبر sale/purchase/inventory/expense/audit/shift
// (نَتيجة /simplify على الموجة ٦).
//
// النَمط المُوحَّد:
// - بلا cursor ⇒ OFFSET + COUNT كَالسابق (توافق عَكسي للواجهات القائمة)
// - مع cursor ⇒ `WHERE id < cursor` + `LIMIT n+1` ⇒ O(log n) بَدل OFFSET الأُسّي
// - hasMore يُحسَب من limit+1 (لا COUNT ثانٍ كَامل عند الـkeyset)
//
// لماذا runQuery callback بَدل تَمرير query builder: drizzle's select shape مُتَنوّعة (joins,
// columns, types) ⇒ الـcallback يَحفظ النوع T للـcaller بَدون cast إلى any.

import { and, lt, type SQL } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";

export interface KeysetPaginateOpts<T> {
  /** المؤشّر (id) إن أَتى من العميل ⇒ نَستعمل keyset. */
  cursor?: number;
  /** حجم الصفحة (افتراضي defaultLimit). */
  limit?: number;
  /** إزاحة (للتَوافق العَكسي فقط — تُتجاهَل عند keyset). */
  offset?: number;
  defaultLimit?: number;
  /** عمود ID على الجدول الأَساس — يُستَعمَل لبناء `lt(idCol, cursor)`. */
  idCol: AnyMySqlColumn;
  /** الشَّروط الأَساسية (قبل إضافة cursor). تُمرَّر للـCOUNT أيضاً عند offset التَوافقي. */
  baseConds: SQL[];
  /** يُنفّذ الاستعلام مع where + limit + offset المَحسوبَين. */
  runQuery: (where: SQL | undefined, fetchLimit: number, fetchOffset: number) => Promise<T[]>;
}

export interface KeysetPaginateResult<T> {
  rows: T[];
  hasMore: boolean;
  nextCursor: number | null;
  /** للـcaller ليُقرّر هل يَحسب COUNT (مَسحٌ ثانٍ مُكلِف عند الملايين). */
  usingCursor: boolean;
}

/**
 * يُدير دورة keyset كاملة: حِساب limit/offset، تَنفيذ الاستعلام، استِخراج page + nextCursor.
 * يَفترض أنّ rows[*] يَحتوي `id` (الأَكثرية تَختار `id: table.id`).
 */
export async function paginateKeyset<T extends { id: number | bigint | string }>(
  opts: KeysetPaginateOpts<T>,
): Promise<KeysetPaginateResult<T>> {
  const usingCursor = opts.cursor != null;
  const conds = usingCursor ? [...opts.baseConds, lt(opts.idCol, opts.cursor!)] : opts.baseConds;
  const where = conds.length ? and(...conds) : undefined;
  const effLimit = opts.limit ?? opts.defaultLimit ?? 50;
  const fetchLimit = usingCursor ? effLimit + 1 : effLimit;
  const fetchOffset = usingCursor ? 0 : (opts.offset ?? 0);
  const raw = await opts.runQuery(where, fetchLimit, fetchOffset);
  const hasMore = usingCursor ? raw.length > effLimit : raw.length === effLimit;
  const rows = usingCursor && hasMore ? raw.slice(0, effLimit) : raw;
  const nextCursor = hasMore && rows.length ? Number(rows[rows.length - 1].id) : null;
  return { rows, hasMore, nextCursor, usingCursor };
}

/** COUNT(*) فقط عند offset التَوافقي. عند keyset يُرجع 0 (تَجنّب مَسحٍ ثانٍ كَامل). */
export async function countIfOffset(
  usingCursor: boolean,
  runCount: () => Promise<number>,
): Promise<number> {
  return usingCursor ? 0 : await runCount();
}
