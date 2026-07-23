// بنك جهات الاتصال (S3، T3.2) — CRUD أشخاص الاتصال B2B (contactPersons، هجرة 0108). طرف واحد
// فقط لكل شخص اتصال (عميل XOR مورّد — لا قيد CHECK على MySQL، يُفرَض تطبيقياً هنا). لا حذف صلب
// (نمط المشروع القائم — تعطيل/تفعيل فقط، راجع deactivateCustomer/setDeliveryPartyActive).
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { contactPersons, customers, suppliers } from "../../../drizzle/schema";
import { extractInsertId } from "../../lib/insertId";
import { normalizeIraqPhoneE164 } from "../../lib/phone";
import type { Actor } from "../tx";
import { requireDb, withTx } from "../tx";

export interface ListContactPersonsInput {
  customerId?: number;
  supplierId?: number;
}

/** قائمة أشخاص اتصال طرف — تتطلّب customerId أو supplierId (بلا أيّهما تعيد قائمة فارغة، لا مسحاً كاملاً). */
export async function listContactPersons(input: ListContactPersonsInput) {
  const conds = [];
  if (input.customerId != null) conds.push(eq(contactPersons.customerId, input.customerId));
  if (input.supplierId != null) conds.push(eq(contactPersons.supplierId, input.supplierId));
  if (!conds.length) return [];
  const db = requireDb();
  return db
    .select()
    .from(contactPersons)
    .where(and(...conds))
    .orderBy(desc(contactPersons.isPrimary), asc(contactPersons.name));
}

export interface ContactPersonOwner {
  customerId: number | null;
  supplierId: number | null;
}

/** يحدّد الطرف المالك لشخص اتصال (عميل XOR مورّد) — للبوّابة الأمنية في الراوتر قبل التعديل/
 *  التعطيل (update/setInactive لا يحملان supplierId في مدخلهما، بخلاف create/list). لا يرمي
 *  NOT_FOUND هنا — الاستدعاء اللاحق للخدمة الفعلية يتولّى ذلك برسالة موحّدة. */
export async function getContactPersonOwner(id: number): Promise<ContactPersonOwner | null> {
  const db = requireDb();
  const row = (
    await db
      .select({ customerId: contactPersons.customerId, supplierId: contactPersons.supplierId })
      .from(contactPersons)
      .where(eq(contactPersons.id, id))
      .limit(1)
  )[0];
  if (!row) return null;
  return {
    customerId: row.customerId != null ? Number(row.customerId) : null,
    supplierId: row.supplierId != null ? Number(row.supplierId) : null,
  };
}

function normPersonPhone(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? normalizeIraqPhoneE164(t) : null;
}

export interface CreateContactPersonInput {
  customerId?: number | null;
  supplierId?: number | null;
  name: string;
  phone?: string | null;
  role?: string | null;
  isPrimary?: boolean;
  notes?: string | null;
}

/** فرض «طرف واحد فقط»: عميل XOR مورّد — لا كلاهما ولا لا شيء. */
function assertSingleParty(customerId: number | null | undefined, supplierId: number | null | undefined): void {
  const hasCustomer = customerId != null;
  const hasSupplier = supplierId != null;
  if (hasCustomer === hasSupplier) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "يجب ربط شخص الاتصال بعميل أو مورّد واحد فقط (لا كلاهما ولا لا شيء)" });
  }
}

export async function createContactPerson(input: CreateContactPersonInput, _actor: Actor) {
  assertSingleParty(input.customerId, input.supplierId);
  const name = input.name?.trim();
  if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم شخص الاتصال مطلوب" });

  return withTx(async (tx) => {
    if (input.customerId != null) {
      const c = (await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customerId)).limit(1))[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
    } else if (input.supplierId != null) {
      const s = (await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1))[0];
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "المورّد غير موجود" });
    }

    const res = await tx.insert(contactPersons).values({
      customerId: input.customerId ?? null,
      supplierId: input.supplierId ?? null,
      name,
      phone: normPersonPhone(input.phone),
      role: input.role?.trim() || null,
      isPrimary: !!input.isPrimary,
      notes: input.notes?.trim() || null,
      isActive: true,
    });
    return { id: extractInsertId(res) };
  });
}

export interface UpdateContactPersonInput {
  id: number;
  name?: string;
  phone?: string | null;
  role?: string | null;
  isPrimary?: boolean;
  notes?: string | null;
}

export async function updateContactPerson(input: UpdateContactPersonInput, _actor: Actor) {
  return withTx(async (tx) => {
    const existing = (
      await tx.select({ id: contactPersons.id }).from(contactPersons).where(eq(contactPersons.id, input.id)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "شخص الاتصال غير موجود" });

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "اسم شخص الاتصال مطلوب" });
      patch.name = name;
    }
    if (input.phone !== undefined) patch.phone = normPersonPhone(input.phone);
    if (input.role !== undefined) patch.role = input.role?.trim() || null;
    if (input.isPrimary !== undefined) patch.isPrimary = input.isPrimary;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

    if (Object.keys(patch).length === 0) return { id: input.id, changed: false };
    await tx.update(contactPersons).set(patch).where(eq(contactPersons.id, input.id));
    return { id: input.id, changed: true };
  });
}

/** تعطيل (soft) — لا حذف صلب. */
export async function setContactPersonInactive(id: number, _actor: Actor) {
  return withTx(async (tx) => {
    const existing = (
      await tx.select({ id: contactPersons.id, isActive: contactPersons.isActive }).from(contactPersons).where(eq(contactPersons.id, id)).for("update").limit(1)
    )[0];
    if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "شخص الاتصال غير موجود" });
    if (!existing.isActive) return { id, isActive: false, changed: false };
    await tx.update(contactPersons).set({ isActive: false }).where(eq(contactPersons.id, id));
    return { id, isActive: false, changed: true };
  });
}
