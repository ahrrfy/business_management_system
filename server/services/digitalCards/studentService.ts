/**
 * ملفّات الطلاب (ش٦) — امتدادٌ لملفّ العميل، لا بديلٌ عنه (§٥.٨ من وثيقة التصميم).
 *
 * توزيع الحقول (مصدر حقيقة واحد لكل حقل — لا ازدواج):
 *   • `customers.name`    ← اسم الطالب
 *   • `customers.phone`   ← هاتف الطالب (مطلوب)
 *   • `customers.address` ← عنوان الطالب (مطلوب)
 *   • `studentProfiles.studentPhone`  ← نسخة **مطبَّعة** من الهاتف الأساسي + حارس تفرّد خاصّ بالطلاب
 *   • `studentProfiles.guardianPhone` ← هاتف ولي الأمر (مطلوب، **غير فريد**: للولي عدّة أبناء)
 *
 * قواعد حاكمة:
 *   • لا دمج تلقائيّ عند التباس: تعدّد المطابقات ⇒ رفضٌ صريح وطلب اختيارٍ إداريّ (منع دمج الإخوة).
 *   • تعديل هاتف الطالب يُحدّث `customers.phone` و`studentProfiles.studentPhone` **معاً** في معاملة واحدة.
 *   • الطالب الجديد يُنشأ داخل معاملة التثبيت النهائية للبيع، لا عند الإضافة للسلة.
 *   • خصوصية: لا يُسجَّل أيّ حقل من بيانات الطالب في السجلّات أو رسائل الأخطاء.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, like, ne, sql } from "drizzle-orm";
import { customers, studentProfiles } from "../../../drizzle/schema";
import type { DB, Tx } from "../../db";
import { extractInsertId } from "../../lib/insertId";
import { normalizeIraqPhoneE164, phoneSuffix10 } from "../../lib/phone";
import type { Actor } from "../tx";

/* ────────── الأنواع ────────── */

/** لقطة بيانات الطالب كما تصل من الكاشير — تُحمَل في سطر السلة ثم تُثبَّت عند البيع. */
export interface StudentSnapshot {
  /** موجود ⇒ ربطٌ بملفٍّ قائم؛ غائب ⇒ طالبٌ جديد يُنشأ عند التثبيت. */
  customerId?: number | null;
  studentName: string;
  studentPhone: string;
  guardianPhone: string;
  address: string;
  /**
   * UPDATE_PROFILE: يكتب التعديلات في ملفّ الطالب.
   * INVOICE_ONLY:  لقطةٌ لهذه الفاتورة فقط — الملفّ لا يُمَسّ (§٨.٤-٥).
   */
  mode: "UPDATE_PROFILE" | "INVOICE_ONLY";
}

export interface StudentMatch {
  customerId: number;
  studentName: string;
  studentPhone: string;
  guardianPhone: string;
  address: string | null;
}

/* ────────── تحقّق ────────── */

const MIN_PHONE_DIGITS = 10;

function requireText(v: string | null | undefined, label: string): string {
  const s = (v ?? "").trim();
  if (!s) throw new TRPCError({ code: "BAD_REQUEST", message: `${label} مطلوب` });
  return s;
}

/** يُطبّع ويتحقّق أنّ الرقم عراقيّ معقول — يرمي برسالةٍ **بلا الرقم نفسه** (لا PII في الأخطاء). */
function requirePhone(v: string | null | undefined, label: string): string {
  const raw = requireText(v, label);
  const normalized = normalizeIraqPhoneE164(raw);
  if ((phoneSuffix10(normalized) ?? "").length < MIN_PHONE_DIGITS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${label} غير صالح — أدخل رقماً عراقياً كاملاً` });
  }
  return normalized;
}

/** يُطبّع اللقطة الواردة ويتحقّق من اكتمالها. يُستدعى قبل أيّ كتابة أو مقارنة. */
export function normalizeSnapshot(input: StudentSnapshot): StudentSnapshot & { studentPhone: string; guardianPhone: string } {
  return {
    customerId: input.customerId ?? null,
    studentName: requireText(input.studentName, "اسم الطالب"),
    studentPhone: requirePhone(input.studentPhone, "هاتف الطالب"),
    guardianPhone: requirePhone(input.guardianPhone, "هاتف ولي الأمر"),
    address: requireText(input.address, "عنوان الطالب"),
    mode: input.mode,
  };
}

/* ────────── البحث ────────── */

const SELECT_MATCH = {
  customerId: studentProfiles.customerId,
  studentName: customers.name,
  studentPhone: studentProfiles.studentPhone,
  guardianPhone: studentProfiles.guardianPhone,
  address: customers.address,
};

/**
 * بحث الكاشير عن طالب. ثلاثة مسارات (§٨.٤):
 *   • `studentPhone`  ⇒ مطابقة **دقيقة** على الهاتف المطبَّع (بلاحقة ١٠ أرقام تسامحاً مع صيغ الكتابة).
 *   • `guardianPhone` ⇒ **كلّ** أبناء هذا الوليّ (قد يكونون إخوة — تُعرض للاختيار، لا تُدمج).
 *   • `q`             ⇒ مطابقة اسم جزئية (مساعدة عند نسيان الرقم).
 * المخرَج بالحدّ الأدنى اللازم للكاشير — لا يُعاد أيّ حقل ماليّ للعميل.
 */
export async function searchStudents(
  db: DB,
  input: { studentPhone?: string; guardianPhone?: string; q?: string; limit?: number },
): Promise<StudentMatch[]> {
  const limit = Math.min(input.limit ?? 20, 50);
  const conds = [];

  if (input.studentPhone?.trim()) {
    const suffix = phoneSuffix10(normalizeIraqPhoneE164(input.studentPhone));
    if (!suffix) return [];
    conds.push(like(studentProfiles.studentPhone, `%${suffix}`));
  }
  if (input.guardianPhone?.trim()) {
    const suffix = phoneSuffix10(normalizeIraqPhoneE164(input.guardianPhone));
    if (!suffix) return [];
    conds.push(like(studentProfiles.guardianPhone, `%${suffix}`));
  }
  if (input.q?.trim()) {
    const needle = input.q.trim().replace(/[%_]/g, "\\$&");
    conds.push(like(customers.name, `%${needle}%`));
  }
  if (!conds.length) return [];

  const rows = await db
    .select(SELECT_MATCH)
    .from(studentProfiles)
    .innerJoin(customers, eq(studentProfiles.customerId, customers.id))
    .where(and(eq(customers.isActive, true), ...conds))
    .orderBy(customers.name)
    .limit(limit);

  return rows.map((r) => ({
    customerId: Number(r.customerId),
    studentName: r.studentName,
    studentPhone: r.studentPhone,
    guardianPhone: r.guardianPhone,
    address: r.address,
  }));
}

/* ────────── الحلّ والتثبيت (يُستدعى داخل معاملة البيع) ────────── */

/** نتيجة محاولة ربط لقطةٍ بلا `customerId` بعميلٍ قائم. */
export type ResolveOutcome =
  | { kind: "NEW" }
  | { kind: "LINK"; customerId: number }
  | { kind: "AMBIGUOUS"; candidates: StudentMatch[] };

/**
 * قبل إنشاء طالبٍ جديد: يبحث عن هاتفه بين العملاء.
 *   • مطابقة وحيدة  ⇒ LINK (يُربط بعد تأكيد الكاشير).
 *   • عدّة مطابقات ⇒ AMBIGUOUS — **لا دمج تلقائيّ**؛ القرار إداريّ (منع دمج الإخوة).
 *   • لا مطابقة    ⇒ NEW.
 */
export async function resolveStudentByPhone(runner: DB | Tx, studentPhone: string): Promise<ResolveOutcome> {
  const suffix = phoneSuffix10(normalizeIraqPhoneE164(studentPhone));
  if (!suffix) return { kind: "NEW" };

  const rows = await runner
    .select({ id: customers.id, name: customers.name, phone: customers.phone, address: customers.address })
    .from(customers)
    .where(and(eq(customers.isActive, true), like(customers.phone, `%${suffix}`)))
    .limit(10);

  if (rows.length === 0) return { kind: "NEW" };
  if (rows.length === 1) return { kind: "LINK", customerId: Number(rows[0].id) };

  return {
    kind: "AMBIGUOUS",
    candidates: rows.map((r) => ({
      customerId: Number(r.id),
      studentName: r.name,
      studentPhone: r.phone ?? "",
      guardianPhone: "",
      address: r.address,
    })),
  };
}

/**
 * يثبّت لقطة الطالب داخل معاملة البيع ويعيد `customerId` الذي تُنسب إليه الفاتورة.
 *
 * • بلا `customerId`: يُحلّ الهاتف؛ الالتباس يرمي CONFLICT (لا دمج صامت)، والوحيد يُربط،
 *   وغير الموجود يُنشأ عميلاً + ملفَّ طالب.
 * • مع `customerId` ووضع UPDATE_PROFILE: يُحدَّث الاسم/الهاتف/العنوان/هاتف الوليّ معاً.
 * • مع `customerId` ووضع INVOICE_ONLY: **لا يُمَسّ الملفّ إطلاقاً** — اللقطة للفاتورة فقط.
 */
export async function commitStudent(
  tx: Tx,
  snapshotIn: StudentSnapshot,
  actor: Actor,
): Promise<{ customerId: number; created: boolean; profileUpdated: boolean }> {
  const snap = normalizeSnapshot(snapshotIn);

  if (snap.customerId != null) {
    const [existing] = await tx
      .select({ id: studentProfiles.id, customerId: studentProfiles.customerId })
      .from(studentProfiles)
      .where(eq(studentProfiles.customerId, snap.customerId))
      .for("update");
    if (!existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "ملفّ الطالب غير موجود" });
    }
    if (snap.mode === "INVOICE_ONLY") {
      return { customerId: snap.customerId, created: false, profileUpdated: false };
    }
    await assertPhoneFree(tx, snap.studentPhone, snap.customerId);
    await tx
      .update(customers)
      .set({ name: snap.studentName, phone: snap.studentPhone, address: snap.address })
      .where(eq(customers.id, snap.customerId));
    await tx
      .update(studentProfiles)
      .set({ studentPhone: snap.studentPhone, guardianPhone: snap.guardianPhone })
      .where(eq(studentProfiles.customerId, snap.customerId));
    return { customerId: snap.customerId, created: false, profileUpdated: true };
  }

  const resolved = await resolveStudentByPhone(tx, snap.studentPhone);
  if (resolved.kind === "AMBIGUOUS") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "أكثر من عميل بهذا الهاتف — اختر الملفّ الصحيح يدوياً (لا دمج تلقائيّ)",
    });
  }

  if (resolved.kind === "LINK") {
    const linkedId = resolved.customerId;
    const [alreadyStudent] = await tx
      .select({ id: studentProfiles.id })
      .from(studentProfiles)
      .where(eq(studentProfiles.customerId, linkedId))
      .limit(1);
    if (alreadyStudent) {
      // العميل طالبٌ أصلاً ⇒ عامِله كتحديث ملفّ قائم بنفس الوضع المطلوب.
      return commitStudent(tx, { ...snap, customerId: linkedId }, actor);
    }
    await assertPhoneFree(tx, snap.studentPhone, linkedId);
    await tx
      .update(customers)
      .set({ name: snap.studentName, phone: snap.studentPhone, address: snap.address })
      .where(eq(customers.id, linkedId));
    await tx.insert(studentProfiles).values({
      customerId: linkedId,
      studentPhone: snap.studentPhone,
      guardianPhone: snap.guardianPhone,
    });
    return { customerId: linkedId, created: false, profileUpdated: true };
  }

  await assertPhoneFree(tx, snap.studentPhone, null);
  const res = await tx.insert(customers).values({
    name: snap.studentName,
    phone: snap.studentPhone,
    address: snap.address,
    customerType: "فرد",
    // «نقدي فقط» — الافتراضي الحاكم للعميل الجديد (قرار المالك ٤/٧). لا ائتمان لطالبٍ يُنشأ من الكاشير.
    creditLimit: "0",
  });
  const customerId = extractInsertId(res);
  await tx.insert(studentProfiles).values({
    customerId,
    studentPhone: snap.studentPhone,
    guardianPhone: snap.guardianPhone,
  });
  return { customerId, created: true, profileUpdated: true };
}

/** حارس التفرّد بلغةٍ مفهومة قبل أن يرميه القيد الفريد برسالةٍ خام. */
async function assertPhoneFree(tx: Tx, studentPhone: string, exceptCustomerId: number | null): Promise<void> {
  const conds = [eq(studentProfiles.studentPhone, studentPhone)];
  if (exceptCustomerId != null) conds.push(ne(studentProfiles.customerId, exceptCustomerId));
  const [clash] = await tx
    .select({ id: studentProfiles.id })
    .from(studentProfiles)
    .where(and(...conds))
    .limit(1);
  if (clash) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "هاتف الطالب مسجَّل لطالبٍ آخر — لكل طالبٍ رقمه الخاصّ",
    });
  }
}

/** بطاقة الطالب لشاشة الإدارة/الفاتورة — بلا أرقام مالية. */
export async function getStudent(db: DB, customerId: number): Promise<StudentMatch | null> {
  const [row] = await db
    .select(SELECT_MATCH)
    .from(studentProfiles)
    .innerJoin(customers, eq(studentProfiles.customerId, customers.id))
    .where(eq(studentProfiles.customerId, customerId))
    .limit(1);
  if (!row) return null;
  return {
    customerId: Number(row.customerId),
    studentName: row.studentName,
    studentPhone: row.studentPhone,
    guardianPhone: row.guardianPhone,
    address: row.address,
  };
}

/** عدد أبناء وليّ أمر — يُظهره الكاشير كتلميح «لهذا الوليّ ٣ أبناء مسجَّلين». */
export async function countSiblings(db: DB, guardianPhone: string): Promise<number> {
  const suffix = phoneSuffix10(normalizeIraqPhoneE164(guardianPhone));
  if (!suffix) return 0;
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(studentProfiles)
    .where(like(studentProfiles.guardianPhone, `%${suffix}`));
  return Number(row?.n ?? 0);
}

/** هل الهاتفان لنفس الشخص بعد التطبيع؟ (تُستعمل لتمييز «تغيّر الهاتف» عن مجرّد اختلاف الكتابة.) */
export function samePhone(a: string, b: string): boolean {
  return normalizeIraqPhoneE164(a) === normalizeIraqPhoneE164(b);
}
