import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { isDupEntry } from "@shared/errorMap.ar";
import { customers, invoices, workOrders } from "../../drizzle/schema";
import { getDb } from "../db";
import { escLike } from "../lib/sqlLike";
import { normalizeSearchText } from "../../shared/searchNormalize";
import { money } from "./money";
import { withTx, type Actor } from "./tx";
import { extractInsertId } from "../lib/insertId";
import { normalizeIraqPhoneE164, phoneSuffix10 } from "../lib/phone";
import { signedOpeningBalance, postOpeningEntry, type OpeningDirection } from "./openingBalance";
import { majorityTokenHitJs, majorityTokenMatch, phoneMatchSuffix } from "../lib/similarMatch";

export type PriceTier = "RETAIL" | "WHOLESALE" | "GOVERNMENT";
export type CustomerType = "فرد" | "تاجر" | "مؤسسة" | "شركة" | "حكومي";

export interface CreateCustomerInput {
  name: string;
  phone?: string | null;
  // v3-add-screens: هاتفان إضافيّان بصيغة E.164.
  phone2?: string | null;
  phone3?: string | null;
  whatsapp?: string | null;
  address?: string | null;
  city?: string | null;
  district?: string | null;
  customerType?: CustomerType;
  defaultPriceTier?: PriceTier;
  creditLimit?: string | null;
  notes?: string | null;
  // رصيد افتتاحي اختياري (مبلغ غير سالب) + اتجاه الدين. يُنشئ قيد OPENING مرجعياً.
  openingBalance?: string | null;
  openingBalanceDirection?: OpeningDirection;
  // dup-detect (٦/٧): مفتاح idempotency — UUID يولّده نموذج الإضافة مرّة لكل فتح. إعادة الإرسال
  // بنفس المفتاح (نقر مزدوج/إعادة محاولة شبكة) تعيد العميل نفسه بدل إنشاء صفٍّ مكرّر.
  clientRequestId?: string | null;
}

export interface UpdateCustomerInput extends Partial<CreateCustomerInput> {
  customerId: number;
}

export interface ListCustomersInput {
  q?: string;
  customerType?: CustomerType;
  priceTier?: PriceTier;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * تطبيع E.164 خادمي (T3.1، بنك جهات الاتصال) — أيّ هاتف مُدخَل (phone/phone2/phone3/whatsapp)
 * يُوحَّد على صيغة +964… واحدة قبل التخزين، فتتلاقى «07701234567» و«+9647701234567» على سجلّ
 * واحد بدل عميلين متكرّرين (نفس مبدأ normalizeStorePhone في مسار المتجر). فارغ يبقى null.
 */
function normPhone(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return normalizeIraqPhoneE164(t);
}

/**
 * تطبيع سقف الائتمان مع الحفاظ على دلالة credit.ts الثلاثية (إصلاح H4):
 *  - `null` صريح ⇒ يُخزَّن `null` = **بلا حدّ** (سماح كامل بالآجل). لا يُقسَر إلى "0".
 *  - `undefined` أو نصّ فارغ ⇒ الافتراض التحفّظي "0" = **حظر آجل** (نقدي فقط).
 *  - نصّ رقمي موجب ⇒ يُتحقَّق منه ويُخزَّن كما هو.
 *
 * ⚠️ قبل هذا الإصلاح كان `creditLimit || "0"` يطمس فرق «بلا حدّ» عن «حظر»، فيستحيل
 * التعبير عن عميل بلا سقف من الواجهة. مسار الكاشير يمرّر "0" صراحةً (لا null) لضمان
 * ألّا يصير عميلٌ ينشئه الكاشير «بلا حدّ» بغير قصد.
 */
function normalizeCreditLimit(input: string | null | undefined): string | null {
  if (input === null) return null; // صريح: بلا حدّ.
  const c = input?.trim();
  if (c && !/^\d+(\.\d{1,2})?$/.test(c))
    throw new TRPCError({ code: "BAD_REQUEST", message: "سقف الائتمان غير صالح" });
  return c || "0"; // غير محدّد/فارغ ⇒ حظر آجل تحفّظياً.
}

async function assertUniquePhone(db: any, phone: string | null, excludeId?: number) {
  if (!phone) return;
  const conds = [eq(customers.phone, phone)];
  if (excludeId) conds.push(ne(customers.id, excludeId));
  const existing = (await db.select({ id: customers.id }).from(customers).where(and(...conds)).limit(1))[0];
  if (existing)
    throw new TRPCError({
      code: "CONFLICT",
      message: `رقم الهاتف ${phone} مسجّل لعميل آخر`,
    });
}

/**
 * إنشاء عميل جديد (ذرّي + تحقق من تكرار الهاتف + idempotency).
 *
 * dup-detect (٦/٧): حين يصل `clientRequestId` (UUID من نموذج الإضافة) يكون الإنشاء idempotent:
 *  - فحص مسبق داخل المعاملة يعيد العميل القائم بنفس المفتاح (إعادة إرسال بعد نجاح سابق).
 *  - سباقان متزامنان بنفس المفتاح: القيد الفريد `uq_customer_client_request` يحسم — الخاسر
 *    يتلقّى ER_DUP_ENTRY فنعيد قراءة الفائز ونعيده (نمط conversationService/sale idempotency).
 *  - إعادة التشغيل لا تكرّر قيد OPENING (الفائز سجّله داخل معاملته الذرّية).
 */
export async function createCustomer(input: CreateCustomerInput, _actor: Actor) {
  const clientRequestId = input.clientRequestId?.trim() || null;
  try {
    return await withTx(async (tx) => {
      const name = input.name?.trim();
      if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم العميل مطلوب" });
      if (name.length > 255)
        throw new TRPCError({ code: "BAD_REQUEST", message: "اسم العميل طويل جداً (٢٥٥ حرفاً كحد أقصى)" });

      // idempotency: إعادة إرسال بنفس المفتاح ⇒ أعد العميل القائم، لا صفاً جديداً ولا قيداً جديداً.
      if (clientRequestId) {
        const prior = (
          await tx.select({ id: customers.id }).from(customers)
            .where(eq(customers.clientRequestId, clientRequestId)).limit(1)
        )[0];
        if (prior) return { customerId: prior.id, idempotentReplay: true };
      }

      const phone = normPhone(input.phone);
      await assertUniquePhone(tx, phone);

      const creditLimit = normalizeCreditLimit(input.creditLimit);
      // رصيد افتتاحي موقَّع (العميل: موجب = «لنا عليه»). "0.00" حين لا رصيد.
      const openingBalance = signedOpeningBalance(
        "CUSTOMER",
        input.openingBalance,
        input.openingBalanceDirection ?? "OWED_TO_US",
      );

      const res = await tx.insert(customers).values({
        name,
        phone,
        phone2: normPhone(input.phone2),
        phone3: normPhone(input.phone3),
        whatsapp: normPhone(input.whatsapp),
        address: input.address?.trim() || null,
        city: input.city?.trim() || null,
        district: input.district?.trim() || null,
        customerType: input.customerType ?? "فرد",
        defaultPriceTier: input.defaultPriceTier ?? "RETAIL",
        creditLimit,
        currentBalance: openingBalance,
        notes: input.notes?.trim() || null,
        clientRequestId,
        isActive: true,
      });
      const customerId = extractInsertId(res);
      // قيد OPENING المرجعي داخل نفس المعاملة (ذرّي مع إنشاء العميل).
      if (!money(openingBalance).isZero()) {
        await postOpeningEntry(tx, "CUSTOMER", customerId, openingBalance);
      }
      return { customerId, idempotentReplay: false };
    });
  } catch (e) {
    // سباق متزامن على نفس المفتاح: الفائز ملتزم (خطأ التكرار لا يُرمى إلا بعد التزامه) ⇒ اقرأه.
    // الفحص بمحاولة القراءة لا بتحليل نصّ الخطأ: إن لم نجد صفاً فمصدر التكرار قيدٌ آخر ⇒ نعيد الرمي.
    if (clientRequestId && isDupEntry(e)) {
      const db = getDb();
      const prior = db
        ? (
            await db.select({ id: customers.id }).from(customers)
              .where(eq(customers.clientRequestId, clientRequestId)).limit(1)
          )[0]
        : undefined;
      if (prior) return { customerId: prior.id, idempotentReplay: true };
    }
    throw e;
  }
}

export interface FindSimilarCustomersInput {
  name?: string | null;
  phones?: (string | null | undefined)[] | null;
  limit?: number;
}

/**
 * dup-detect (٦/٧، ترقية ٢٠/٧): مرشّحو تكرار محتمَل لشاشة إضافة العميل — تحذير حيّ قبل الحفظ لا حجب.
 * المطابقة: الاسم بقاعدة **أغلبية الكلمات** على `searchNorm` (نواة similarMatch المشتركة مع
 * كاشفَي المنتجات والمورّدين — تمسك ترتيب كلمات مختلفاً واسماً مكتوباً أطول من المخزَّن،
 * وكانت المطابقة القديمة سلسلةً متصلةً تفوّتهما)، والهواتف الأربعة بمطابقة لاحقة أرقام
 * (صيغة محلية تجد المخزَّن دولياً). يشمل المعطَّلين عمداً — «موجود لكنه معطَّل» أهم تحذيرات
 * التكرار (الحجب البنيوي للهاتف الأساسي المطابق يبقى في assertUniquePhone).
 */
export async function findSimilarCustomers(input: FindSimilarCustomersInput) {
  const db = getDb();
  if (!db) return [];
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);

  const nameRaw = input.name?.trim() ?? "";
  // حارس طول على الفضاء المُطبَّع (سلوك سابق مصون): حرف واحد مثل «ا» يطابق كل شيء LIKE.
  const match = normalizeSearchText(nameRaw).length >= 2 ? majorityTokenMatch(sql`${customers.searchNorm}`, nameRaw) : null;
  const suffixes = Array.from(
    new Set((input.phones ?? []).map(phoneMatchSuffix).filter((s): s is string => !!s)),
  ).slice(0, 4);

  const conds: ReturnType<typeof sql>[] = [];
  if (match) conds.push(match.where);
  for (const suf of suffixes) {
    const p = `%${escLike(suf)}`;
    conds.push(sql`${customers.phone} LIKE ${p} ESCAPE '!'`);
    conds.push(sql`${customers.phone2} LIKE ${p} ESCAPE '!'`);
    conds.push(sql`${customers.phone3} LIKE ${p} ESCAPE '!'`);
    conds.push(sql`${customers.whatsapp} LIKE ${p} ESCAPE '!'`);
  }
  if (conds.length === 0) return [];

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      phone2: customers.phone2,
      phone3: customers.phone3,
      whatsapp: customers.whatsapp,
      city: customers.city,
      customerType: customers.customerType,
      currentBalance: customers.currentBalance,
      isActive: customers.isActive,
    })
    .from(customers)
    .where(or(...conds))
    // ملاءمة الاسم أولاً (تام ثم عدد الكلمات) ثم النشِط ثم أبجدياً — مطابقات الهاتف الصرفة تلي الاسمية.
    .orderBy(...(match ? match.orderBy : []), desc(customers.isActive), asc(customers.name))
    .limit(limit);

  return rows.map((r) => {
    const rowDigits = [r.phone, r.phone2, r.phone3, r.whatsapp].map((x) => (x ?? "").replace(/\D/g, ""));
    const phoneHit = suffixes.some((suf) => rowDigits.some((d) => d.length > 0 && d.endsWith(suf)));
    // مرآة JS لقاعدة الأغلبية نفسها — تصنيف matchedOn متّسق مع شرط SQL.
    const nameHit = !!match && majorityTokenHitJs(r.name, nameRaw);
    const { phone2: _p2, phone3: _p3, whatsapp: _wa, ...pub } = r;
    return {
      ...pub,
      matchedOn: (phoneHit && nameHit ? "both" : phoneHit ? "phone" : "name") as "both" | "phone" | "name",
    };
  });
}

/** تعديل عميل قائم. */
export async function updateCustomer(input: UpdateCustomerInput, _actor: Actor) {
  return withTx(async (tx) => {
    const existing = (
      await tx.select().from(customers).where(eq(customers.id, input.customerId)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم العميل مطلوب" });
      if (name.length > 255)
        throw new TRPCError({ code: "BAD_REQUEST", message: "اسم العميل طويل جداً" });
      patch.name = name;
    }
    if (input.phone !== undefined) {
      const phone = normPhone(input.phone);
      await assertUniquePhone(tx, phone, input.customerId);
      patch.phone = phone;
    }
    if (input.phone2 !== undefined) patch.phone2 = normPhone(input.phone2);
    if (input.phone3 !== undefined) patch.phone3 = normPhone(input.phone3);
    if (input.whatsapp !== undefined) patch.whatsapp = normPhone(input.whatsapp);
    if (input.address !== undefined) patch.address = input.address?.trim() || null;
    if (input.city !== undefined) patch.city = input.city?.trim() || null;
    if (input.district !== undefined) patch.district = input.district?.trim() || null;
    if (input.customerType !== undefined) patch.customerType = input.customerType;
    if (input.defaultPriceTier !== undefined) patch.defaultPriceTier = input.defaultPriceTier;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    if (input.creditLimit !== undefined) {
      // نفس دلالة الإنشاء: null صريح ⇒ بلا حدّ؛ فارغ ⇒ "0" حظر؛ رقم ⇒ يُتحقَّق.
      patch.creditLimit = normalizeCreditLimit(input.creditLimit);
    }

    if (Object.keys(patch).length === 0) return { customerId: input.customerId, changed: false };

    await tx.update(customers).set(patch).where(eq(customers.id, input.customerId));
    return { customerId: input.customerId, changed: true };
  });
}

/** تعطيل عميل (soft delete) — يُرفض إن كان عليه رصيد مفتوح. */
export async function deactivateCustomer(customerId: number, _actor: Actor) {
  return withTx(async (tx) => {
    const c = (
      await tx.select().from(customers).where(eq(customers.id, customerId)).for("update").limit(1)
    )[0];
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    if (!c.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "العميل معطّل بالفعل" });

    // الأموال عبر decimal.js (§٥) — أي رصيد غير صفري (مدين أو دائن) يمنع التعطيل.
    const balance = money(c.currentBalance ?? "0");
    if (!balance.isZero())
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `لا يمكن تعطيل عميل عليه رصيد مفتوح (${balance.toFixed(2)}) — سدّد الذمم أولاً`,
      });

    // الفواتير غير المسوّاة (لا PAID/CANCELLED/RETURNED) = التزام قائم ⇒ تمنع التعطيل.
    const open = (
      await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.customerId, customerId),
            inArray(invoices.status, ["PENDING", "CONFIRMED", "PARTIALLY_PAID"]),
          ),
        )
        .limit(1)
    )[0];
    if (open)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "لا يمكن تعطيل عميل له فواتير غير مسوّاة (معلّقة/مؤكّدة/مدفوعة جزئياً)",
      });

    await tx.update(customers).set({ isActive: false }).where(eq(customers.id, customerId));
    return { customerId, isActive: false };
  });
}

/** إعادة تفعيل عميل معطّل. */
export async function activateCustomer(customerId: number, _actor: Actor) {
  return withTx(async (tx) => {
    const c = (
      await tx.select().from(customers).where(eq(customers.id, customerId)).for("update").limit(1)
    )[0];
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    if (c.isActive) throw new TRPCError({ code: "BAD_REQUEST", message: "العميل مفعّل بالفعل" });
    await tx.update(customers).set({ isActive: true }).where(eq(customers.id, customerId));
    return { customerId, isActive: true };
  });
}

/** قراءة بطاقة عميل واحدة. */
export async function getCustomer(customerId: number) {
  const db = getDb();
  if (!db) return null;
  return (
    await db.select().from(customers).where(eq(customers.id, customerId)).limit(1)
  )[0] ?? null;
}

/** قائمة عملاء مع بحث وفلاتر وتقسيم صفحات.
 * الفجوة ١٦: الحد الأعلى ٢٠٠٠ صف لكل طلب (افتراضي ١٠٠) — حماية pool الاتصالات
 * من طلبٍ مفرد يطلب الجدول كاملاً ويستنفد ذاكرة العملية.
 */
export async function listCustomers(input: ListCustomersInput = {}) {
  const db = getDb();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 2000);
  const offset = Math.max(input.offset ?? 0, 0);

  const conds: any[] = [];
  if (!input.includeInactive) conds.push(eq(customers.isActive, true));
  if (input.customerType) conds.push(eq(customers.customerType, input.customerType));
  if (input.priceTier) conds.push(eq(customers.defaultPriceTier, input.priceTier));
  if (input.q?.trim()) {
    const raw = input.q.trim();
    const q = `%${escLike(raw)}%`;
    // D2 (١/٧): الاسم يُطابَق عبر searchNorm المُطبَّع عربياً (نفس نمط المنتجات) — «ازرق» يجد
    // «أزرق». الهواتف/الرقم القديم تبقى مطابقة خام (لا معنى للتطبيع العربي على أرقام).
    const qFolded = `%${escLike(normalizeSearchText(raw))}%`;
    const orConds = [
      sql`coalesce(${customers.searchNorm}, '') LIKE ${qFolded} ESCAPE '!'`,
      // v3-add-screens: البحث يطال هواتف العميل الثلاثة + الواتساب.
      sql`${customers.phone} LIKE ${q} ESCAPE '!'`,
      sql`${customers.phone2} LIKE ${q} ESCAPE '!'`,
      sql`${customers.phone3} LIKE ${q} ESCAPE '!'`,
      sql`${customers.whatsapp} LIKE ${q} ESCAPE '!'`,
      // import-integration: + «الرقم القديم» (legacyCode) — معرّف النظام القديم بعد الاستيراد.
      sql`${customers.legacyCode} LIKE ${q} ESCAPE '!'`,
    ];
    // T3.2 (إصلاح إلزامي — انحدار بحث الهاتف): T3.1 طبّع الهواتف الجديدة إلى E.164 (+964…) لكن
    // LIKE الخام أعلاه لا يطابق «0770…» المحلي ضدّ «+964770…» المخزَّن. لاحقة آخر ١٠ أرقام تطابق
    // كلا الصيغتين (نفس نواة phoneMatchSuffix المُستعملة في findSimilarCustomers) — تُضاف OR
    // لا تحذف الشروط الخامة القائمة (البحث الجزئي/الرقم القديم يبقيان كما هما).
    const suf = phoneSuffix10(raw);
    if (suf) {
      const sufPat = `%${escLike(suf)}`;
      orConds.push(
        sql`${customers.phone} LIKE ${sufPat} ESCAPE '!'`,
        sql`${customers.phone2} LIKE ${sufPat} ESCAPE '!'`,
        sql`${customers.phone3} LIKE ${sufPat} ESCAPE '!'`,
        sql`${customers.whatsapp} LIKE ${sufPat} ESCAPE '!'`,
      );
    }
    conds.push(or(...orConds));
  }
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      whatsapp: customers.whatsapp,
      city: customers.city,
      district: customers.district,
      customerType: customers.customerType,
      defaultPriceTier: customers.defaultPriceTier,
      creditLimit: customers.creditLimit,
      currentBalance: customers.currentBalance,
      // import-integration: «الرقم القديم» يظهر عموداً في الشاشة ويُصدَّر في Excel.
      legacyCode: customers.legacyCode,
      isActive: customers.isActive,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .where(where as any)
    .orderBy(asc(customers.name), desc(customers.id))
    .limit(limit)
    .offset(offset);

  const totalRow = (
    await db.select({ n: sql<number>`COUNT(*)` }).from(customers).where(where as any)
  )[0];

  return { rows, total: Number(totalRow?.n ?? 0) };
}

/**
 * v3-add-screens: بحث ذكي عن العملاء لإدخال أمر شغل بسرعة.
 *
 * - يعيد المعرّف + الاسم + الهاتف + إحصاءات مختصرة (عدد فواتير + عدد أوامر شغل + آخر طلب + إجمالي إنفاق).
 * - يحدّ النتائج لتجنّب الإغراق (افتراضي ٦).
 * - تصنيف بسيط: VIP = ≥ ١٠ طلبات، متكرّر = ≥ ٣، وإلا عادي.
 *
 * تعليل: حسبنا الإحصاءات بدّفعتين (فواتير + أوامر شغل) ثم دمجنا بمفتاح العميل،
 * لأن إجراء جوينَين في استعلام واحد يضاعف الصفوف ⇒ عدّ غير دقيق.
 */
export async function smartSearchCustomers(input: { q: string; limit?: number }) {
  const db = getDb();
  if (!db) return [];
  const q = input.q?.trim();
  if (!q || q.length < 2) return [];
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 20);

  const like_ = `%${escLike(q)}%`;
  // D2 (١/٧): الاسم يُطابَق عبر searchNorm المُطبَّع عربياً (نفس نمط listCustomers أعلاه).
  const likeFolded = `%${escLike(normalizeSearchText(q))}%`;
  const smartOrConds = [
    sql`coalesce(${customers.searchNorm}, '') LIKE ${likeFolded} ESCAPE '!'`,
    sql`${customers.phone} LIKE ${like_} ESCAPE '!'`,
    sql`${customers.phone2} LIKE ${like_} ESCAPE '!'`,
    sql`${customers.phone3} LIKE ${like_} ESCAPE '!'`,
    sql`${customers.whatsapp} LIKE ${like_} ESCAPE '!'`,
  ];
  // T3.2 (إصلاح إلزامي — انحدار بحث الهاتف): هذه الدالة تغذّي CustomerPicker في الكاشير مباشرةً —
  // أخطر مستهلكٍ للانحدار (بند ٠ الإلزامي). نفس منطق اللاحقة في listCustomers أعلاه.
  const smartSuf = phoneSuffix10(q);
  if (smartSuf) {
    const sufPat = `%${escLike(smartSuf)}`;
    smartOrConds.push(
      sql`${customers.phone} LIKE ${sufPat} ESCAPE '!'`,
      sql`${customers.phone2} LIKE ${sufPat} ESCAPE '!'`,
      sql`${customers.phone3} LIKE ${sufPat} ESCAPE '!'`,
      sql`${customers.whatsapp} LIKE ${sufPat} ESCAPE '!'`,
    );
  }
  // S5 (٣٠/٦): إضافة defaultPriceTier + currentBalance — حقلان رخيصان من نفس صفّ العملاء
  // يُمكّنان CustomerPicker الكاشير من البحث الخادمي بدل تحميل ٥٠٠ عميل عند الإقلاع.
  const matched = await db
    .select({
      id: customers.id,
      name: customers.name,
      phone: customers.phone,
      defaultPriceTier: customers.defaultPriceTier,
      currentBalance: customers.currentBalance,
    })
    .from(customers)
    .where(and(eq(customers.isActive, true), or(...smartOrConds)))
    .orderBy(asc(customers.name))
    .limit(limit);

  if (matched.length === 0) return [];

  const ids = matched.map((m) => m.id);

  const invStats = await db
    .select({
      customerId: invoices.customerId,
      count: sql<number>`COUNT(*)`,
      lastAt: sql<string>`MAX(${invoices.invoiceDate})`,
      total: sql<string>`COALESCE(SUM(${invoices.total}), 0)`,
    })
    .from(invoices)
    .where(and(inArray(invoices.customerId, ids), ne(invoices.status, "CANCELLED")))
    .groupBy(invoices.customerId);

  const woStats = await db
    .select({
      customerId: workOrders.customerId,
      count: sql<number>`COUNT(*)`,
      lastAt: sql<string>`MAX(${workOrders.createdAt})`,
    })
    .from(workOrders)
    .where(and(inArray(workOrders.customerId, ids), ne(workOrders.status, "CANCELLED")))
    .groupBy(workOrders.customerId);

  const invMap = new Map<number, { count: number; lastAt: string | null; total: string }>();
  for (const r of invStats) {
    if (r.customerId == null) continue;
    invMap.set(Number(r.customerId), { count: Number(r.count), lastAt: r.lastAt ?? null, total: String(r.total ?? "0") });
  }
  const woMap = new Map<number, { count: number; lastAt: string | null }>();
  for (const r of woStats) {
    if (r.customerId == null) continue;
    woMap.set(Number(r.customerId), { count: Number(r.count), lastAt: r.lastAt ?? null });
  }

  return matched.map((m) => {
    const inv = invMap.get(m.id);
    const wo = woMap.get(m.id);
    const orderCount = (inv?.count ?? 0) + (wo?.count ?? 0);
    // آخر طلب = أحدث الاثنين (نقارن سلاسل ISO/Date كنصوص بأمان إن كانت بنفس الشكل).
    const lastCandidates = [inv?.lastAt, wo?.lastAt].filter(Boolean) as string[];
    const lastOrderAt = lastCandidates.length
      ? lastCandidates.sort().slice(-1)[0]
      : null;
    return {
      id: m.id,
      name: m.name,
      phone: m.phone,
      // S5 (٣٠/٦): فئة السعر + الذمة الجارية لاستهلاك CustomerPicker الكاشير.
      defaultPriceTier: m.defaultPriceTier,
      currentBalance: m.currentBalance,
      orderCount,
      lastOrderAt,
      totalSpent: inv?.total ?? "0",
      isVip: orderCount >= 10,
      isFrequent: orderCount >= 3 && orderCount < 10,
    };
  });
}

