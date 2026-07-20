import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, like, ne, or, sql } from "drizzle-orm";
import { purchaseOrders, suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import { escapeLike } from "../lib/sqlLike";
import { normalizeSearchText } from "../../shared/searchNormalize";
import { money } from "./money";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { signedOpeningBalance, postOpeningEntry, type OpeningDirection } from "./openingBalance";
import { majorityTokenHitJs, majorityTokenMatch, phoneMatchSuffix } from "../lib/similarMatch";

export interface CreateSupplierInput {
  name: string;
  phone?: string | null;
  // v3-add-screens: هاتفان إضافيّان دوليّان (E.164).
  phone2?: string | null;
  phone3?: string | null;
  email?: string | null;
  whatsapp?: string | null;
  address?: string | null;
  city?: string | null;
  taxId?: string | null;
  productTypes?: string | null;
  paymentTerms?: string | null;
  notes?: string | null;
  // v3-add-screens: حقول تجاريّة جديدة.
  supplierCategory?: string | null;
  leadTimeDays?: number | null;
  minOrderAmount?: string | null;
  rating?: number | null;
  iban?: string | null;
  bankName?: string | null;
  // رصيد افتتاحي اختياري (مبلغ غير سالب) + اتجاه الدين. يُنشئ قيد OPENING مرجعياً.
  openingBalance?: string | null;
  openingBalanceDirection?: OpeningDirection;
}
export interface UpdateSupplierInput extends Partial<CreateSupplierInput> {
  supplierId: number;
}
export interface ListSuppliersInput {
  q?: string;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

const norm = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t || null;
};

async function assertUniquePhone(db: any, phone: string | null, excludeId?: number) {
  if (!phone) return;
  const conds = [eq(suppliers.phone, phone)];
  if (excludeId) conds.push(ne(suppliers.id, excludeId));
  const existing = (await db.select({ id: suppliers.id }).from(suppliers).where(and(...conds)).limit(1))[0];
  if (existing) throw new TRPCError({ code: "CONFLICT", message: `رقم الهاتف ${phone} مسجّل لمورّد آخر` });
}

/** إنشاء مورّد (ذرّي + تحقّق تكرار الهاتف). */
export async function createSupplier(input: CreateSupplierInput, _actor: Actor) {
  return withTx(async (tx) => {
    const name = input.name?.trim();
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المورّد مطلوب" });
    if (name.length > 255) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المورّد طويل جداً (٢٥٥ حرفاً)" });
    const phone = norm(input.phone);
    await assertUniquePhone(tx, phone);
    const rating = input.rating != null ? Math.min(5, Math.max(0, Math.trunc(input.rating))) : null;
    const leadTime = input.leadTimeDays != null ? Math.max(0, Math.trunc(input.leadTimeDays)) : null;
    const minOrder = input.minOrderAmount?.trim();
    if (minOrder && !/^\d+(\.\d{1,2})?$/.test(minOrder))
      throw new TRPCError({ code: "BAD_REQUEST", message: "الحد الأدنى للطلب غير صالح" });
    // رصيد افتتاحي موقَّع (المورّد: موجب = «علينا له»). "0.00" حين لا رصيد.
    const openingBalance = signedOpeningBalance(
      "SUPPLIER",
      input.openingBalance,
      input.openingBalanceDirection ?? "OWED_BY_US",
    );
    const res = await tx.insert(suppliers).values({
      name,
      phone,
      phone2: norm(input.phone2),
      phone3: norm(input.phone3),
      email: norm(input.email),
      whatsapp: norm(input.whatsapp),
      address: norm(input.address),
      city: norm(input.city),
      taxId: norm(input.taxId),
      productTypes: norm(input.productTypes),
      paymentTerms: norm(input.paymentTerms),
      supplierCategory: norm(input.supplierCategory),
      leadTimeDays: leadTime,
      minOrderAmount: minOrder || null,
      rating,
      iban: norm(input.iban),
      bankName: norm(input.bankName),
      currentBalance: openingBalance,
      notes: norm(input.notes),
      isActive: true,
    });
    const supplierId = extractInsertId(res);
    // قيد OPENING المرجعي داخل نفس المعاملة (ذرّي مع إنشاء المورّد).
    if (!money(openingBalance).isZero()) {
      await postOpeningEntry(tx, "SUPPLIER", supplierId, openingBalance);
    }
    return { supplierId, id: supplierId };
  });
}

/** تعديل مورّد قائم. */
export async function updateSupplier(input: UpdateSupplierInput, _actor: Actor) {
  return withTx(async (tx) => {
    const existing = (await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).for("update").limit(1))[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "المورّد غير موجود" });
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المورّد مطلوب" });
      patch.name = name;
    }
    if (input.phone !== undefined) {
      const phone = norm(input.phone);
      await assertUniquePhone(tx, phone, input.supplierId);
      patch.phone = phone;
    }
    if (input.phone2 !== undefined) patch.phone2 = norm(input.phone2);
    if (input.phone3 !== undefined) patch.phone3 = norm(input.phone3);
    if (input.email !== undefined) patch.email = norm(input.email);
    if (input.whatsapp !== undefined) patch.whatsapp = norm(input.whatsapp);
    if (input.address !== undefined) patch.address = norm(input.address);
    if (input.city !== undefined) patch.city = norm(input.city);
    if (input.taxId !== undefined) patch.taxId = norm(input.taxId);
    if (input.productTypes !== undefined) patch.productTypes = norm(input.productTypes);
    if (input.paymentTerms !== undefined) patch.paymentTerms = norm(input.paymentTerms);
    if (input.supplierCategory !== undefined) patch.supplierCategory = norm(input.supplierCategory);
    if (input.leadTimeDays !== undefined)
      patch.leadTimeDays = input.leadTimeDays != null ? Math.max(0, Math.trunc(input.leadTimeDays)) : null;
    if (input.minOrderAmount !== undefined) {
      const m = input.minOrderAmount?.trim();
      if (m && !/^\d+(\.\d{1,2})?$/.test(m))
        throw new TRPCError({ code: "BAD_REQUEST", message: "الحد الأدنى للطلب غير صالح" });
      patch.minOrderAmount = m || null;
    }
    if (input.rating !== undefined)
      patch.rating = input.rating != null ? Math.min(5, Math.max(0, Math.trunc(input.rating))) : null;
    if (input.iban !== undefined) patch.iban = norm(input.iban);
    if (input.bankName !== undefined) patch.bankName = norm(input.bankName);
    if (input.notes !== undefined) patch.notes = norm(input.notes);
    if (Object.keys(patch).length === 0) return { supplierId: input.supplierId, changed: false };
    await tx.update(suppliers).set(patch).where(eq(suppliers.id, input.supplierId));
    return { supplierId: input.supplierId, changed: true };
  });
}

/** تعطيل مورّد — يُرفض إن كان عليه رصيد مفتوح أو أوامر شراء غير مسوّاة. */
export async function deactivateSupplier(supplierId: number, _actor: Actor) {
  return withTx(async (tx) => {
    const s = (await tx.select().from(suppliers).where(eq(suppliers.id, supplierId)).for("update").limit(1))[0];
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "المورّد غير موجود" });
    if (!s.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "المورّد معطّل بالفعل" });

    const balance = money(s.currentBalance ?? "0");
    if (!balance.isZero())
      throw new TRPCError({ code: "BAD_REQUEST", message: `لا يمكن تعطيل مورّد عليه رصيد مفتوح (${balance.toFixed(2)}) — سدّد الذمم أولاً` });

    const open = (
      await tx.select({ id: purchaseOrders.id }).from(purchaseOrders)
        .where(and(eq(purchaseOrders.supplierId, supplierId), sql`${purchaseOrders.status} IN ('CONFIRMED','RECEIVED') AND ${purchaseOrders.paidAmount} < ${purchaseOrders.total}`))
        .limit(1)
    )[0];
    if (open) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن تعطيل مورّد له أوامر شراء غير مسوّاة" });

    await tx.update(suppliers).set({ isActive: false }).where(eq(suppliers.id, supplierId));
    return { supplierId, isActive: false };
  });
}

/** إعادة تفعيل مورّد معطّل. */
export async function activateSupplier(supplierId: number, _actor: Actor) {
  return withTx(async (tx) => {
    const s = (await tx.select().from(suppliers).where(eq(suppliers.id, supplierId)).for("update").limit(1))[0];
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "المورّد غير موجود" });
    if (s.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "المورّد مفعّل بالفعل" });
    await tx.update(suppliers).set({ isActive: true }).where(eq(suppliers.id, supplierId));
    return { supplierId, isActive: true };
  });
}

/** قراءة بطاقة مورّد. */
export async function getSupplier(supplierId: number) {
  const db = getDb();
  if (!db) return null;
  return (await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1))[0] ?? null;
}

/** قائمة موردين مع بحث وتقسيم صفحات.
 * الفجوة ١٦: الحد الأعلى ٢٠٠٠ (افتراضي ١٠٠) — يمنع طلباً مفرداً من استنفاد
 * pool الاتصالات أو ذاكرة العملية بتنزيل آلاف الصفوف بلا تجزئة.
 */
export async function listSuppliers(input: ListSuppliersInput = {}) {
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 2000);
  const offset = Math.max(input.offset ?? 0, 0);
  const conds: any[] = [];
  if (!input.includeInactive) conds.push(eq(suppliers.isActive, true));
  if (input.q?.trim()) {
    const q = `%${escapeLike(input.q.trim())}%`;
    // D2 (١/٧): الاسم يُطابَق عبر searchNorm المُطبَّع عربياً (نفس نمط المنتجات/العملاء) — «ازرق»
    // يجد «أزرق». بقية الحقول تبقى مطابقة خام (لا معنى للتطبيع العربي على أرقام/تصنيف إنجليزي).
    const qFolded = `%${escapeLike(normalizeSearchText(input.q.trim()))}%`;
    // v3-add-screens: البحث يشمل هواتف المورّد الثلاثة + المدينة + التصنيف.
    // import-integration: + «الرقم القديم» (legacyCode) — معرّف النظام القديم بعد الاستيراد.
    conds.push(or(
      sql`coalesce(${suppliers.searchNorm}, '') LIKE ${qFolded}`,
      like(suppliers.phone, q),
      like(suppliers.phone2, q),
      like(suppliers.phone3, q),
      like(suppliers.city, q),
      like(suppliers.supplierCategory, q),
      like(suppliers.legacyCode, q),
    ));
  }
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      phone: suppliers.phone,
      city: suppliers.city,
      paymentTerms: suppliers.paymentTerms,
      currentBalance: suppliers.currentBalance,
      // import-integration: «الرقم القديم» يظهر عموداً في الشاشة ويُصدَّر في Excel.
      legacyCode: suppliers.legacyCode,
      isActive: suppliers.isActive,
      createdAt: suppliers.createdAt,
    })
    .from(suppliers)
    .where(where as any)
    .orderBy(asc(suppliers.name), desc(suppliers.id))
    .limit(limit)
    .offset(offset);
  const totalRow = (await db.select({ n: sql<number>`COUNT(*)` }).from(suppliers).where(where as any))[0];
  return { rows, total: Number(totalRow?.n ?? 0) };
}

export interface FindSimilarSuppliersInput {
  name?: string | null;
  phones?: (string | null | undefined)[] | null;
  limit?: number;
}

/**
 * dup-detect (٢٠/٧): مرشّحو تكرار محتمَل لشاشة إضافة المورّد — تحذير حيّ قبل الحفظ لا حجب
 * (مرآة findSimilarCustomers على نواة similarMatch المشتركة). الاسم بقاعدة **أغلبية الكلمات**
 * على `searchNorm` (تمسك ترتيب كلمات مختلفاً واسماً أطول من المخزَّن — «شركة المعارف للطباعة»
 * تجد «المعارف للطباعة»)، والهواتف الأربعة بمطابقة لاحقة أرقام (محلية 07xx تجد ‎+9647xx‎).
 * يشمل المعطَّلين عمداً، ولا يُعيد أرصدة (البطاقة التحذيرية لا تعرضها — أقلّ امتيازاً).
 */
export async function findSimilarSuppliers(input: FindSimilarSuppliersInput) {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);

  const nameRaw = input.name?.trim() ?? "";
  // حارس طول على الفضاء المُطبَّع: حرف واحد مثل «ا» يطابق كل شيء LIKE.
  const match = normalizeSearchText(nameRaw).length >= 2 ? majorityTokenMatch(sql`${suppliers.searchNorm}`, nameRaw) : null;
  const suffixes = Array.from(
    new Set((input.phones ?? []).map(phoneMatchSuffix).filter((s): s is string => !!s)),
  ).slice(0, 4);

  const conds: ReturnType<typeof sql>[] = [];
  if (match) conds.push(match.where);
  for (const suf of suffixes) {
    const p = `%${escapeLike(suf)}`;
    conds.push(sql`${suppliers.phone} LIKE ${p}`);
    conds.push(sql`${suppliers.phone2} LIKE ${p}`);
    conds.push(sql`${suppliers.phone3} LIKE ${p}`);
    conds.push(sql`${suppliers.whatsapp} LIKE ${p}`);
  }
  if (conds.length === 0) return [];

  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.name,
      phone: suppliers.phone,
      phone2: suppliers.phone2,
      phone3: suppliers.phone3,
      whatsapp: suppliers.whatsapp,
      city: suppliers.city,
      supplierCategory: suppliers.supplierCategory,
      isActive: suppliers.isActive,
    })
    .from(suppliers)
    .where(or(...conds))
    // ملاءمة الاسم أولاً (تام ثم عدد الكلمات) ثم النشِط ثم أبجدياً.
    .orderBy(...(match ? match.orderBy : []), desc(suppliers.isActive), asc(suppliers.name))
    .limit(limit);

  return rows.map((r) => {
    const rowDigits = [r.phone, r.phone2, r.phone3, r.whatsapp].map((x) => (x ?? "").replace(/\D/g, ""));
    const phoneHit = suffixes.some((suf) => rowDigits.some((d) => d.length > 0 && d.endsWith(suf)));
    const nameHit = !!match && majorityTokenHitJs(r.name, nameRaw);
    const { phone2: _p2, phone3: _p3, whatsapp: _wa, ...pub } = r;
    return {
      ...pub,
      matchedOn: (phoneHit && nameHit ? "both" : phoneHit ? "phone" : "name") as "both" | "phone" | "name",
    };
  });
}
