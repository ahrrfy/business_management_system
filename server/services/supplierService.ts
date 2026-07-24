import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, like, ne, or, sql } from "drizzle-orm";
import { isDupEntry } from "@shared/errorMap.ar";
import { branchStock, productVariants, products, purchaseOrders, suppliers } from "../../drizzle/schema";
import { getDb } from "../db";
import { escapeLike } from "../lib/sqlLike";
import { normalizeSearchText } from "../../shared/searchNormalize";
import { money } from "./money";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { normalizeIraqPhoneE164, phoneSuffix10 } from "../lib/phone";
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
  // بضاعة الأمانة (٢٠/٧): نوع الطرف + حقول اتفاقية المودِع (CONSIGNOR فقط). راجع docs/consignment-design-2026-07-20.md.
  supplierKind?: "REGULAR" | "CONSIGNOR";
  settlementCycle?: string | null;
  abandonedAfterMonths?: number | null;
  autoSettleThreshold?: string | null;
  agreementNotes?: string | null;
  agreementAttachmentUrl?: string | null;
  // رصيد افتتاحي اختياري (مبلغ غير سالب) + اتجاه الدين. يُنشئ قيد OPENING مرجعياً.
  openingBalance?: string | null;
  openingBalanceDirection?: OpeningDirection;
  // مفتاح idempotency — UUID يولّده نموذج الإضافة مرّة لكل فتح. إعادة الإرسال بنفس المفتاح
  // (نقر مزدوج/إعادة محاولة شبكة) تعيد المورّد نفسه بدل إنشاء صفٍّ مكرّر.
  clientRequestId?: string | null;
}
export interface UpdateSupplierInput extends Partial<CreateSupplierInput> {
  supplierId: number;
}
export interface ListSuppliersInput {
  q?: string;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
  // بضاعة الأمانة: فلتر نوع الطرف (منتقي المودِعين + فلتر شاشة الموردين).
  kind?: "REGULAR" | "CONSIGNOR";
}

const norm = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t || null;
};

/**
 * تطبيع E.164 خادمي (T3.1، بنك جهات الاتصال) — خاصّ بحقول الهاتف فقط (phone/phone2/phone3/
 * whatsapp)؛ `norm()` أعلاه يبقى بلا تغيير لبقية الحقول (بريد/عنوان/ملاحظات…) كي لا تُقحَم صيغة
 * الهاتف عليها. فارغ يبقى null.
 */
const normPhoneField = (s: string | null | undefined): string | null => {
  const t = norm(s);
  return t ? normalizeIraqPhoneE164(t) : null;
};

/** بضاعة الأمانة: تطبيع حقول اتفاقية المودِع + التحقّق منها (مشترك بين الإنشاء والتعديل). */
function normalizeConsignmentFields(input: {
  settlementCycle?: string | null;
  abandonedAfterMonths?: number | null;
  autoSettleThreshold?: string | null;
  agreementNotes?: string | null;
  agreementAttachmentUrl?: string | null;
}) {
  let abandoned: number | null = null;
  if (input.abandonedAfterMonths != null) {
    abandoned = Math.trunc(input.abandonedAfterMonths);
    if (!Number.isFinite(abandoned) || abandoned < 1 || abandoned > 120)
      throw new TRPCError({ code: "BAD_REQUEST", message: "مدة البضاعة المتروكة بين 1 و120 شهراً" });
  }
  const threshold = input.autoSettleThreshold?.trim();
  if (threshold && !/^\d+(\.\d{1,2})?$/.test(threshold))
    throw new TRPCError({ code: "BAD_REQUEST", message: "عتبة التسوية الفورية غير صالحة" });
  return {
    settlementCycle: norm(input.settlementCycle) ?? "MONTHLY",
    abandonedAfterMonths: abandoned ?? 12,
    autoSettleThreshold: threshold || null,
    agreementNotes: norm(input.agreementNotes),
    agreementAttachmentUrl: norm(input.agreementAttachmentUrl),
  };
}

async function assertUniquePhone(db: any, phone: string | null, excludeId?: number) {
  if (!phone) return;
  const conds = [eq(suppliers.phone, phone)];
  if (excludeId) conds.push(ne(suppliers.id, excludeId));
  const existing = (await db.select({ id: suppliers.id }).from(suppliers).where(and(...conds)).limit(1))[0];
  if (existing) throw new TRPCError({ code: "CONFLICT", message: `رقم الهاتف ${phone} مسجّل لمورّد آخر` });
}

/**
 * إنشاء مورّد (ذرّي + تحقّق تكرار الهاتف + idempotency).
 *
 * حين يصل `clientRequestId` (UUID من نموذج الإضافة) يكون الإنشاء idempotent — نظير createCustomer:
 *  - فحص مسبق داخل المعاملة يعيد المورّد القائم بنفس المفتاح (إعادة إرسال بعد نجاح سابق).
 *  - سباقان متزامنان بنفس المفتاح: القيد الفريد `uq_supplier_client_request` يحسم — الخاسر
 *    يتلقّى ER_DUP_ENTRY فنعيد قراءة الفائز ونعيده.
 *  - إعادة التشغيل لا تكرّر قيد OPENING (الفائز سجّله داخل معاملته الذرّية).
 */
export async function createSupplier(input: CreateSupplierInput, _actor: Actor) {
  const clientRequestId = input.clientRequestId?.trim() || null;
  try {
    return await createSupplierTx(input, clientRequestId);
  } catch (e) {
    // سباق متزامن على نفس المفتاح: الفائز ملتزم (خطأ التكرار لا يُرمى إلا بعد التزامه) ⇒ اقرأه.
    // الفحص بمحاولة القراءة لا بتحليل نصّ الخطأ: إن لم نجد صفاً فمصدر التكرار قيدٌ آخر ⇒ نعيد الرمي.
    if (clientRequestId && isDupEntry(e)) {
      const db = getDb();
      const prior = db
        ? (
            await db.select({ id: suppliers.id }).from(suppliers)
              .where(eq(suppliers.clientRequestId, clientRequestId)).limit(1)
          )[0]
        : undefined;
      if (prior) return { supplierId: prior.id, id: prior.id, idempotentReplay: true };
    }
    throw e;
  }
}

async function createSupplierTx(input: CreateSupplierInput, clientRequestId: string | null) {
  return withTx(async (tx) => {
    const name = input.name?.trim();
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المورّد مطلوب" });
    if (name.length > 255) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم المورّد طويل جداً (٢٥٥ حرفاً)" });

    // idempotency: إعادة إرسال بنفس المفتاح ⇒ أعد المورّد القائم، لا صفاً جديداً ولا قيداً جديداً.
    if (clientRequestId) {
      const prior = (
        await tx.select({ id: suppliers.id }).from(suppliers)
          .where(eq(suppliers.clientRequestId, clientRequestId)).limit(1)
      )[0];
      if (prior) return { supplierId: prior.id, id: prior.id, idempotentReplay: true };
    }

    const phone = normPhoneField(input.phone);
    await assertUniquePhone(tx, phone);
    const rating = input.rating != null ? Math.min(5, Math.max(0, Math.trunc(input.rating))) : null;
    const leadTime = input.leadTimeDays != null ? Math.max(0, Math.trunc(input.leadTimeDays)) : null;
    const minOrder = input.minOrderAmount?.trim();
    if (minOrder && !/^\d+(\.\d{1,2})?$/.test(minOrder))
      throw new TRPCError({ code: "BAD_REQUEST", message: "الحد الأدنى للطلب غير صالح" });
    const kind = input.supplierKind === "CONSIGNOR" ? "CONSIGNOR" : "REGULAR";
    const consignFields = normalizeConsignmentFields(input);
    // رصيد افتتاحي موقَّع (المورّد: موجب = «علينا له»). "0.00" حين لا رصيد.
    const openingBalance = signedOpeningBalance(
      "SUPPLIER",
      input.openingBalance,
      input.openingBalanceDirection ?? "OWED_BY_US",
    );
    const res = await tx.insert(suppliers).values({
      name,
      phone,
      phone2: normPhoneField(input.phone2),
      phone3: normPhoneField(input.phone3),
      email: norm(input.email),
      whatsapp: normPhoneField(input.whatsapp),
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
      clientRequestId,
      supplierKind: kind,
      ...consignFields,
      isActive: true,
    });
    const supplierId = extractInsertId(res);
    // قيد OPENING المرجعي داخل نفس المعاملة (ذرّي مع إنشاء المورّد).
    if (!money(openingBalance).isZero()) {
      await postOpeningEntry(tx, "SUPPLIER", supplierId, openingBalance);
    }
    return { supplierId, id: supplierId, idempotentReplay: false };
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
      const phone = normPhoneField(input.phone);
      await assertUniquePhone(tx, phone, input.supplierId);
      patch.phone = phone;
    }
    if (input.phone2 !== undefined) patch.phone2 = normPhoneField(input.phone2);
    if (input.phone3 !== undefined) patch.phone3 = normPhoneField(input.phone3);
    if (input.email !== undefined) patch.email = norm(input.email);
    if (input.whatsapp !== undefined) patch.whatsapp = normPhoneField(input.whatsapp);
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
    // بضاعة الأمانة: حقول الاتفاقية قابلة للتعديل دائماً.
    if (input.settlementCycle !== undefined) patch.settlementCycle = norm(input.settlementCycle) ?? "MONTHLY";
    if (input.abandonedAfterMonths !== undefined) {
      const m = input.abandonedAfterMonths;
      if (m != null && (!Number.isFinite(m) || Math.trunc(m) < 1 || Math.trunc(m) > 120))
        throw new TRPCError({ code: "BAD_REQUEST", message: "مدة البضاعة المتروكة بين 1 و120 شهراً" });
      patch.abandonedAfterMonths = m != null ? Math.trunc(m) : 12;
    }
    if (input.autoSettleThreshold !== undefined) {
      const t = input.autoSettleThreshold?.trim();
      if (t && !/^\d+(\.\d{1,2})?$/.test(t))
        throw new TRPCError({ code: "BAD_REQUEST", message: "عتبة التسوية الفورية غير صالحة" });
      patch.autoSettleThreshold = t || null;
    }
    if (input.agreementNotes !== undefined) patch.agreementNotes = norm(input.agreementNotes);
    if (input.agreementAttachmentUrl !== undefined) patch.agreementAttachmentUrl = norm(input.agreementAttachmentUrl);
    // نوع الطرف يُقفل بعد أول حركة: لا تحويل مورّد↔مودِع لحساب له أوامر شراء أو أصناف أمانة مربوطة.
    // (ش٢ ستوسّعه ليشمل سندات الأمانة.) يمنع خلط دلالتين ماليتين على نفس الحساب.
    if (input.supplierKind !== undefined && input.supplierKind !== existing.supplierKind) {
      const [hasPo] = await tx.select({ id: purchaseOrders.id }).from(purchaseOrders)
        .where(eq(purchaseOrders.supplierId, input.supplierId)).limit(1);
      const [hasProd] = await tx.select({ id: products.id }).from(products)
        .where(and(eq(products.consignorId, input.supplierId), eq(products.isConsignment, true))).limit(1);
      if (hasPo || hasProd)
        throw new TRPCError({ code: "BAD_REQUEST", message: "لا يُغيَّر نوع حساب له حركات (أوامر شراء أو أصناف أمانة)" });
      patch.supplierKind = input.supplierKind;
    }
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

    // بضاعة الأمانة: مودِع له بضاعة متبقية على الرف (رصيد > 0 في أي فرع) لا يُعطَّل — اسحبها بسند سحب أولاً،
    // وإلا بقيت بضاعة الغير في الأرفف بلا مالك نشط. (حارس §٨ حالات الحافة في التصميم.)
    if (s.supplierKind === "CONSIGNOR") {
      const [stock] = await tx
        .select({ vid: branchStock.variantId })
        .from(branchStock)
        .innerJoin(productVariants, eq(productVariants.id, branchStock.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(eq(products.consignorId, supplierId), eq(products.isConsignment, true), sql`${branchStock.quantity} > 0`))
        .limit(1);
      if (stock)
        throw new TRPCError({ code: "BAD_REQUEST", message: "للمودِع بضاعة متبقية لدينا — أرجعها بسند سحب أولاً ثم عطّله" });
    }

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
  if (input.kind) conds.push(eq(suppliers.supplierKind, input.kind));
  if (input.q?.trim()) {
    const raw = input.q.trim();
    const q = `%${escapeLike(raw)}%`;
    // D2 (١/٧): الاسم يُطابَق عبر searchNorm المُطبَّع عربياً (نفس نمط المنتجات/العملاء) — «ازرق»
    // يجد «أزرق». بقية الحقول تبقى مطابقة خام (لا معنى للتطبيع العربي على أرقام/تصنيف إنجليزي).
    const qFolded = `%${escapeLike(normalizeSearchText(raw))}%`;
    const orConds = [
      sql`coalesce(${suppliers.searchNorm}, '') LIKE ${qFolded}`,
      // v3-add-screens: البحث يشمل هواتف المورّد الثلاثة + المدينة + التصنيف.
      like(suppliers.phone, q),
      like(suppliers.phone2, q),
      like(suppliers.phone3, q),
      like(suppliers.city, q),
      like(suppliers.supplierCategory, q),
      // import-integration: + «الرقم القديم» (legacyCode) — معرّف النظام القديم بعد الاستيراد.
      like(suppliers.legacyCode, q),
    ];
    // T3.2 (إصلاح إلزامي — انحدار بحث الهاتف): نظير customerService.listCustomers — لاحقة آخر
    // ١٠ أرقام تطابق «0770…» المحلي ضدّ «+964770…» المخزَّن بعد تطبيع T3.1. تُضاف OR على أعمدة
    // الهاتف الأربعة (يشمل whatsapp التي لم تكن مطابَقة أصلاً هنا) — لا تُحذف الشروط الخامة القائمة.
    const suf = phoneSuffix10(raw);
    if (suf) {
      const sufPat = `%${escapeLike(suf)}`;
      orConds.push(
        like(suppliers.phone, sufPat),
        like(suppliers.phone2, sufPat),
        like(suppliers.phone3, sufPat),
        like(suppliers.whatsapp, sufPat),
      );
    }
    conds.push(or(...orConds));
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
      // بضاعة الأمانة: نوع الطرف — لفلتر/شارة الشاشة ومنتقي المودِعين.
      supplierKind: suppliers.supplierKind,
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
