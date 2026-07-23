// بنك جهات الاتصال (S3، T3.2) — كشف ازدواج للقراءة فقط (لا دمج في v1 — قرار موثَّق أدناه).
// يُعيد استخدام findSimilarCustomers/findSimilarSuppliers القائمتين بالضبط (نواة similarMatch
// المشتركة: majorityTokenMatch + phoneMatchSuffix) — لا تكرار منطق مطابقة.
import { TRPCError } from "@trpc/server";
import { findSimilarCustomers, getCustomer } from "../customerService";
import { findSimilarSuppliers, getSupplier } from "../supplierService";

export interface FindContactDuplicatesInput {
  kind: "customer" | "supplier";
  /** إن مُرِّر: يُستكمَل الاسم/الهواتف من سجلّه القائم (فحص «هل لهذا الطرف نظائر مشابهة؟») —
   *  ويُستبعَد هو نفسه من النتائج. */
  id?: number;
  name?: string;
  phone?: string;
}

/** v1: قراءة فقط — لا زرّ دمج ولا تعديل. الدمج (توحيد سجلّين لطرف واحد) قرار مالك مؤجَّل عمداً؛
 *  الشاشة (T3.3) تعرض المرشّحين كتحذيرٍ يدويّ فقط. */
export async function findContactDuplicates(input: FindContactDuplicatesInput) {
  if (!input.id && !input.name?.trim() && !input.phone?.trim()) return [];

  if (input.kind === "customer") {
    let name = input.name;
    const phones: (string | null | undefined)[] = input.phone ? [input.phone] : [];
    if (input.id != null) {
      const c = await getCustomer(input.id);
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
      name = name ?? c.name;
      phones.push(c.phone, c.phone2, c.phone3, c.whatsapp);
    }
    const rows = await findSimilarCustomers({ name, phones, limit: 10 });
    return rows.filter((r) => input.id == null || Number(r.id) !== input.id);
  }

  let name = input.name;
  const phones: (string | null | undefined)[] = input.phone ? [input.phone] : [];
  if (input.id != null) {
    const s = await getSupplier(input.id);
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "المورّد غير موجود" });
    name = name ?? s.name;
    phones.push(s.phone, s.phone2, s.phone3, s.whatsapp);
  }
  const rows = await findSimilarSuppliers({ name, phones, limit: 10 });
  return rows.filter((r) => input.id == null || Number(r.id) !== input.id);
}
