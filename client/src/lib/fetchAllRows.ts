// جلب كل النتائج المطابقة للفلاتر (لا الصفحة المعروضة فقط) — لتصدير شامل.
//
// القوائم مُصفّحة خادمياً (limit/offset)، فالتصدير من الصفحة الحالية يُخرج جزءاً فقط.
// هذا المساعد يكرّر عبر offset حتى تنضب الصفحات، فيُعيد كامل المجموعة المطابقة للفلاتر.
// آمن بسقفٍ أقصى يمنع أي حلقة لا نهائية، ويتوقّف فور بلوغ total (إن توفّر) أو صفحة ناقصة.
//
// يدعم procs التي تُعيد {rows,total} أو مصفوفة صرفة (لُفّها: arr => ({ rows: arr })).

export async function fetchAllPaged<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ rows: T[]; total?: number | null }>,
  opts: { pageSize?: number; hardCap?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 500;
  const hardCap = opts.hardCap ?? 100_000;
  const out: T[] = [];
  let offset = 0;
  // حلقة آمنة: تتوقّف عند صفحة أقصر من pageSize، أو بلوغ total، أو السقف الأقصى.
  for (;;) {
    const { rows, total } = await fetchPage(offset, pageSize);
    out.push(...rows);
    if (rows.length < pageSize) break; // آخر صفحة
    offset += rows.length;
    if (total != null && out.length >= total) break;
    if (out.length >= hardCap) break; // صمّام أمان
  }
  return out;
}
