// بنك جهات الاتصال (S3، T3.2) — راوتر tRPC: بحث موحّد + بطاقة ٣٦٠° + موافقة واتساب + أشخاص
// اتصال B2B + كشف ازدواج. يعيد استخدام مفتاح صلاحيات «crm» القائم (crmReadProcedure/
// crmWriteProcedure) — بلا مفتاح صلاحيات جديد (النطاق صارم). نمط tasksRouter.ts: قراءة/كتابة +
// logAudit على كل كتابة.
//
// ⚠️ بوّابة موردين صريحة (T3.2 إصلاح أمني): بيانات المورّد محكومة بوحدة `suppliers` منفصلة
// (مثلاً cashier/sales_rep/print_operator لهم suppliers=NONE بقالبهم — انظر shared/permissions.ts)
// بينما كل مسارات هذا الراوتر على بوّابة `crm` وحدها. أي مسار يخصّ مورّداً (contact360 بالنوع
// supplier، findDuplicates بالنوع supplier، persons عندما supplierId مُمرَّر أو مُستنتَج) يفحص
// وصول suppliers صراحةً عبر assertSupplierModuleAccess أدناه — نظير suppliersReadProcedure/
// suppliersManagerProcedure في server/trpc.ts بالضبط (لا تعريف بوّابة جديدة، إعادة استعمال
// hasModuleAccess/moduleAccessAllowed من shared/permissions لضمان تطابق الدلالة).
import { hasModuleAccess, moduleAccessAllowed, type AccessLevel } from "@shared/permissions";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { logAudit } from "../services/auditService";
import { maskCustomerSensitive, maskSupplierSensitive } from "../lib/redact";
import {
  contact360,
  createContactPerson,
  findContactDuplicates,
  getContactPersonOwner,
  listContactPersons,
  searchContacts,
  setContactPersonInactive,
  setWaConsent,
  updateContactPerson,
  type ContactKind,
} from "../services/contacts";
import { crmReadProcedure, crmWriteProcedure, router } from "../trpc";

const contactKind = z.enum(["customer", "supplier", "delivery", "wa_unlinked"]);
const partyKind = z.enum(["customer", "supplier"]);
const waConsentValue = z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]);

const ALL_CONTACT_KINDS: ContactKind[] = ["customer", "supplier", "delivery", "wa_unlinked"];
/** يطابق roles قائمة suppliersManagerProcedure في trpc.ts بالضبط. */
const SUPPLIER_WRITE_ROLES = ["manager", "warehouse", "purchasing"] as const;

function overrideOf(ctx: { user: { permissionsOverride?: unknown } }): Record<string, AccessLevel> | null | undefined {
  return ctx.user.permissionsOverride as Record<string, AccessLevel> | null | undefined;
}

/** هل يملك المستخدم وصول suppliers بهذا المستوى؟ — نفس دلالة suppliersReadProcedure (READ، بلا
 *  قيد أدوار — الخريطة المحلولة لأي دور تكفي) وsuppliersManagerProcedure (FULL، مقصور على
 *  manager/warehouse/purchasing + منح صريح لأي دور آخر). */
function canAccessSuppliers(ctx: { user: { role: string; permissionsOverride?: unknown } }, level: AccessLevel): boolean {
  const override = overrideOf(ctx);
  if (level === "READ") return hasModuleAccess(ctx.user.role, override, "suppliers", "READ");
  return moduleAccessAllowed(ctx.user.role, override, "suppliers", "FULL", SUPPLIER_WRITE_ROLES);
}

/** يرمي FORBIDDEN إن لم يملك المستخدم وصول suppliers بالمستوى المطلوب. */
function assertSupplierModuleAccess(ctx: { user: { role: string; permissionsOverride?: unknown } }, level: AccessLevel): void {
  if (!canAccessSuppliers(ctx, level)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا صلاحية للوصول لبيانات الموردين" });
  }
}

const personsRouter = router({
  list: crmReadProcedure
    .input(
      z.object({
        customerId: z.number().int().positive().optional(),
        supplierId: z.number().int().positive().optional(),
      }),
    )
    .query(({ input, ctx }) => {
      if (input.supplierId != null) assertSupplierModuleAccess(ctx, "READ");
      return listContactPersons(input);
    }),

  create: crmWriteProcedure
    .input(
      z.object({
        customerId: z.number().int().positive().nullish(),
        supplierId: z.number().int().positive().nullish(),
        name: z.string().min(1).max(160),
        phone: z.string().max(25).nullish(),
        role: z.string().max(60).nullish(),
        isPrimary: z.boolean().optional(),
        notes: z.string().max(255).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.supplierId != null) assertSupplierModuleAccess(ctx, "FULL");
      const res = await createContactPerson(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, {
        action: "contactPerson.create",
        entityType: "contactPerson",
        entityId: res.id,
        newValue: { name: input.name, customerId: input.customerId ?? null, supplierId: input.supplierId ?? null },
      });
      return res;
    }),

  update: crmWriteProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1).max(160).optional(),
        phone: z.string().max(25).nullish(),
        role: z.string().max(60).nullish(),
        isPrimary: z.boolean().optional(),
        notes: z.string().max(255).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // id لا يحمل supplierId مباشرةً — يُستنتَج من السجلّ القائم (النمط: تحديد المالك قبل الفحص،
      // نظير contact360/findDuplicates اللذين يفحصان بالنوع الصريح).
      const owner = await getContactPersonOwner(input.id);
      if (owner?.supplierId != null) assertSupplierModuleAccess(ctx, "FULL");
      const res = await updateContactPerson(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "contactPerson.update", entityType: "contactPerson", entityId: input.id, newValue: input });
      return res;
    }),

  setInactive: crmWriteProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const owner = await getContactPersonOwner(input.id);
      if (owner?.supplierId != null) assertSupplierModuleAccess(ctx, "FULL");
      const res = await setContactPersonInactive(input.id, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "contactPerson.setInactive", entityType: "contactPerson", entityId: input.id });
      return res;
    }),
});

const waConsentRouter = router({
  set: crmWriteProcedure
    .input(z.object({ customerId: z.number().int().positive(), consent: waConsentValue }))
    .mutation(async ({ input, ctx }) => {
      const res = await setWaConsent(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, {
        action: "customer.waConsent.set",
        entityType: "customer",
        entityId: input.customerId,
        newValue: { waConsent: input.consent },
      });
      return res;
    }),
});

export const contactsRouter = router({
  /** بحث موحّد عبر عملاء/موردين/أطراف توصيل/مرسلي واتساب غير المربوطين. مصدر «supplier» يُستبعَد
   *  بصمت (لا خطأ) لمن لا يملك وصول suppliers≥READ — العملاء/التوصيل/واتساب تبقى بحسب crm/الفرع
   *  كما كانت (بلا فحص إضافي). */
  search: crmReadProcedure
    .input(
      z.object({
        q: z.string().min(1).max(120),
        kinds: z.array(contactKind).min(1).max(4).optional(),
        cursor: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    )
    .query(({ ctx, input }) => {
      const requested = input.kinds?.length ? input.kinds : ALL_CONTACT_KINDS;
      const kinds = canAccessSuppliers(ctx, "READ") ? requested : requested.filter((k) => k !== "supplier");
      if (kinds.length === 0) return { rows: [], hasMore: false, nextCursor: null };
      return searchContacts({ scopedBranchId: ctx.scopedBranchId }, { ...input, kinds });
    }),

  /** بطاقة ٣٦٠° لطرف واحد (عميل أو مورّد) — تجميع قراءة فقط، الأرصدة محجوبة لغير المدير،
   *  ومحادثات/مهام العميل مقصورة على فرع المستخدم (غير المرتفعين)؛ نوع supplier يتطلّب
   *  وصول suppliers≥READ صراحةً (بوّابة الوحدة المُتجاوَزة تاريخياً عبر crm — إصلاح T3.2). */
  contact360: crmReadProcedure
    .input(z.object({ kind: partyKind, id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      if (input.kind === "supplier") assertSupplierModuleAccess(ctx, "READ");
      const res = await contact360(input, { scopedBranchId: ctx.scopedBranchId });
      if (res.kind === "customer") return { ...res, customer: maskCustomerSensitive(res.customer, ctx.user.role) };
      return { ...res, supplier: maskSupplierSensitive(res.supplier, ctx.user.role) };
    }),

  /** كشف ازدواج للقراءة فقط — لا دمج (v1، قرار موثَّق في duplicates.ts). نوع supplier يتطلّب
   *  وصول suppliers≥READ (إصلاح T3.2). */
  findDuplicates: crmReadProcedure
    .input(
      z.object({
        kind: partyKind,
        id: z.number().int().positive().optional(),
        name: z.string().max(255).optional(),
        phone: z.string().max(25).optional(),
      }),
    )
    .query(({ ctx, input }) => {
      if (input.kind === "supplier") assertSupplierModuleAccess(ctx, "READ");
      return findContactDuplicates(input);
    }),

  waConsent: waConsentRouter,
  persons: personsRouter,
});
