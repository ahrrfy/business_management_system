// بنك جهات الاتصال (S3، T3.2) — بحث موحّد عبر أربعة مصادر: عملاء + موردون + أطراف توصيل +
// مرسلو واتساب غير المربوطين بعميل. كل مصدر يُستعلَم مستقلاً (نفس نمط globalSearch/orchestrator.ts:
// Promise.all لكل نوع مطلوب) ثم يُدمَج ويُرتَّب بالاسم — بلا keyset حقيقي عبر مصادر غير متجانسة
// (اقتراح المواصفة البديل: limit + hasMore)، مع cursor اختياري كإزاحة رقمية في القائمة المُدمَجة
// المُرتَّبة (بسيط ومحدَّد السلوك، لا يزعم keyset O(log n) حقيقياً).
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { conversations, customers, deliveryParties, suppliers } from "../../../drizzle/schema";
import { escLike } from "../../lib/sqlLike";
import { phoneSuffix10 } from "../../lib/phone";
import { normalizeSearchText } from "../../../shared/searchNormalize";
import { requireDb } from "../tx";

export type ContactKind = "customer" | "supplier" | "delivery" | "wa_unlinked";

export interface UnifiedContact {
  kind: ContactKind;
  id: number;
  name: string;
  phone: string | null;
  /** حقل ثانوي حرّ يعتمد على النوع: مدينة (عميل/مورّد)، عهدة COD (توصيل). */
  secondary: string | null;
  branchId: number | null;
}

export interface ContactsSearchCtx {
  /** null = عابر للفروع (مدير/أدمن)؛ رقم = عزل فرع (يطال أطراف التوصيل/محادثات واتساب فقط —
   *  العملاء/الموردون بلا branchId في المخطط ⇒ بحثهما عابر للفروع دوماً، بقرار تصميم موثَّق). */
  scopedBranchId: number | null;
}

export interface ContactsSearchInput {
  q: string;
  kinds?: ContactKind[];
  /** إزاحة رقمية في القائمة المُدمَجة المُرتَّبة (وليس معرّف صفّ — انظر ملاحظة الملف). */
  cursor?: number;
  limit?: number;
}

export interface ContactsSearchResult {
  rows: UnifiedContact[];
  hasMore: boolean;
  nextCursor: number | null;
}

const ALL_KINDS: readonly ContactKind[] = ["customer", "supplier", "delivery", "wa_unlinked"];

export async function searchContacts(ctx: ContactsSearchCtx, input: ContactsSearchInput): Promise<ContactsSearchResult> {
  const db = requireDb();
  const q = input.q?.trim();
  if (!q || q.length < 2) return { rows: [], hasMore: false, nextCursor: null };

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const offset = Math.max(input.cursor ?? 0, 0);
  // نجلب حتى (الإزاحة + الحدّ + ١) من كل مصدر — يكفي لصفحات ضحلة نمطية لواجهة البحث الموحّد،
  // بحدٍّ أقصى أمانٍ يمنع استعلاماً بلا سقف عند إزاحة كبيرة غير متوقَّعة.
  const perTypeLimit = Math.min(offset + limit + 1, 200);

  const wanted = new Set<ContactKind>(input.kinds?.length ? input.kinds : ALL_KINDS);

  const like_ = `%${escLike(q)}%`;
  const likeFolded = `%${escLike(normalizeSearchText(q))}%`;
  const suf = phoneSuffix10(q);
  const sufPat = suf ? `%${escLike(suf)}` : null;

  const tasks: Promise<UnifiedContact[]>[] = [];

  if (wanted.has("customer")) {
    tasks.push(
      (async () => {
        const orConds = [
          sql`coalesce(${customers.searchNorm}, '') LIKE ${likeFolded} ESCAPE '!'`,
          sql`${customers.phone} LIKE ${like_} ESCAPE '!'`,
          sql`${customers.phone2} LIKE ${like_} ESCAPE '!'`,
          sql`${customers.phone3} LIKE ${like_} ESCAPE '!'`,
          sql`${customers.whatsapp} LIKE ${like_} ESCAPE '!'`,
          sql`${customers.legacyCode} LIKE ${like_} ESCAPE '!'`,
        ];
        if (sufPat) {
          orConds.push(
            sql`${customers.phone} LIKE ${sufPat} ESCAPE '!'`,
            sql`${customers.phone2} LIKE ${sufPat} ESCAPE '!'`,
            sql`${customers.phone3} LIKE ${sufPat} ESCAPE '!'`,
            sql`${customers.whatsapp} LIKE ${sufPat} ESCAPE '!'`,
          );
        }
        const rows = await db
          .select({ id: customers.id, name: customers.name, phone: customers.phone, city: customers.city })
          .from(customers)
          .where(and(eq(customers.isActive, true), or(...orConds)))
          .orderBy(asc(customers.name))
          .limit(perTypeLimit);
        return rows.map((r) => ({
          kind: "customer" as const,
          id: Number(r.id),
          name: r.name,
          phone: r.phone,
          secondary: r.city ?? null,
          branchId: null,
        }));
      })(),
    );
  }

  if (wanted.has("supplier")) {
    tasks.push(
      (async () => {
        const orConds = [
          sql`coalesce(${suppliers.searchNorm}, '') LIKE ${likeFolded} ESCAPE '!'`,
          sql`${suppliers.phone} LIKE ${like_} ESCAPE '!'`,
          sql`${suppliers.phone2} LIKE ${like_} ESCAPE '!'`,
          sql`${suppliers.phone3} LIKE ${like_} ESCAPE '!'`,
          sql`${suppliers.whatsapp} LIKE ${like_} ESCAPE '!'`,
          sql`${suppliers.legacyCode} LIKE ${like_} ESCAPE '!'`,
        ];
        if (sufPat) {
          orConds.push(
            sql`${suppliers.phone} LIKE ${sufPat} ESCAPE '!'`,
            sql`${suppliers.phone2} LIKE ${sufPat} ESCAPE '!'`,
            sql`${suppliers.phone3} LIKE ${sufPat} ESCAPE '!'`,
            sql`${suppliers.whatsapp} LIKE ${sufPat} ESCAPE '!'`,
          );
        }
        const rows = await db
          .select({ id: suppliers.id, name: suppliers.name, phone: suppliers.phone, city: suppliers.city })
          .from(suppliers)
          .where(and(eq(suppliers.isActive, true), or(...orConds)))
          .orderBy(asc(suppliers.name))
          .limit(perTypeLimit);
        return rows.map((r) => ({
          kind: "supplier" as const,
          id: Number(r.id),
          name: r.name,
          phone: r.phone,
          secondary: r.city ?? null,
          branchId: null,
        }));
      })(),
    );
  }

  if (wanted.has("delivery")) {
    tasks.push(
      (async () => {
        const orConds = [
          sql`${deliveryParties.name} LIKE ${like_} ESCAPE '!'`,
          sql`${deliveryParties.phone} LIKE ${like_} ESCAPE '!'`,
          sql`${deliveryParties.phone2} LIKE ${like_} ESCAPE '!'`,
        ];
        if (sufPat) {
          orConds.push(
            sql`${deliveryParties.phone} LIKE ${sufPat} ESCAPE '!'`,
            sql`${deliveryParties.phone2} LIKE ${sufPat} ESCAPE '!'`,
          );
        }
        const conds = [eq(deliveryParties.isActive, true), or(...orConds)];
        // عزل الفرع: نظير listDeliveryParties (eq صارم — لا OR isNull) لغير المرتفعين.
        if (ctx.scopedBranchId != null) conds.push(eq(deliveryParties.branchId, ctx.scopedBranchId));
        const rows = await db
          .select({
            id: deliveryParties.id,
            name: deliveryParties.name,
            phone: deliveryParties.phone,
            currentBalance: deliveryParties.currentBalance,
            branchId: deliveryParties.branchId,
          })
          .from(deliveryParties)
          .where(and(...conds))
          .orderBy(asc(deliveryParties.name))
          .limit(perTypeLimit);
        return rows.map((r) => ({
          kind: "delivery" as const,
          id: Number(r.id),
          name: r.name,
          phone: r.phone,
          secondary: r.currentBalance != null ? String(r.currentBalance) : null,
          branchId: r.branchId != null ? Number(r.branchId) : null,
        }));
      })(),
    );
  }

  if (wanted.has("wa_unlinked")) {
    tasks.push(
      (async () => {
        const orConds = [
          sql`${conversations.displayName} LIKE ${like_} ESCAPE '!'`,
          sql`${conversations.channelHandle} LIKE ${like_} ESCAPE '!'`,
        ];
        if (sufPat) orConds.push(sql`${conversations.channelHandle} LIKE ${sufPat} ESCAPE '!'`);
        const conds = [eq(conversations.channel, "WHATSAPP"), isNull(conversations.customerId), or(...orConds)];
        if (ctx.scopedBranchId != null) conds.push(eq(conversations.branchId, ctx.scopedBranchId));
        const rows = await db
          .select({
            id: conversations.id,
            displayName: conversations.displayName,
            channelHandle: conversations.channelHandle,
            branchId: conversations.branchId,
          })
          .from(conversations)
          .where(and(...conds))
          .orderBy(asc(conversations.displayName))
          .limit(perTypeLimit);
        return rows.map((r) => ({
          kind: "wa_unlinked" as const,
          id: Number(r.id),
          name: r.displayName?.trim() || r.channelHandle,
          phone: r.channelHandle,
          secondary: null,
          branchId: r.branchId != null ? Number(r.branchId) : null,
        }));
      })(),
    );
  }

  const groups = await Promise.all(tasks);
  const merged = groups.flat().sort((a, b) => a.name.localeCompare(b.name, "ar"));

  const sliceEnd = offset + limit;
  const rows = merged.slice(offset, sliceEnd);
  const hasMore = merged.length > sliceEnd;
  const nextCursor = hasMore ? sliceEnd : null;
  return { rows, hasMore, nextCursor };
}
