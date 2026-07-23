// بنك جهات الاتصال (S3، T3.2) — راوتر tRPC: بحث موحّد + بطاقة ٣٦٠° + موافقة واتساب + أشخاص
// اتصال B2B + كشف ازدواج. يعيد استخدام مفتاح صلاحيات «crm» القائم (crmReadProcedure/
// crmWriteProcedure) — بلا مفتاح صلاحيات جديد (النطاق صارم). نمط tasksRouter.ts: قراءة/كتابة +
// logAudit على كل كتابة.
import { z } from "zod";
import { logAudit } from "../services/auditService";
import { maskCustomerSensitive, maskSupplierSensitive } from "../lib/redact";
import { contact360, createContactPerson, findContactDuplicates, listContactPersons, searchContacts, setContactPersonInactive, setWaConsent, updateContactPerson } from "../services/contacts";
import { crmReadProcedure, crmWriteProcedure, router } from "../trpc";

const contactKind = z.enum(["customer", "supplier", "delivery", "wa_unlinked"]);
const partyKind = z.enum(["customer", "supplier"]);
const waConsentValue = z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]);

const personsRouter = router({
  list: crmReadProcedure
    .input(
      z.object({
        customerId: z.number().int().positive().optional(),
        supplierId: z.number().int().positive().optional(),
      }),
    )
    .query(({ input }) => listContactPersons(input)),

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
      const res = await updateContactPerson(input, { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1, role: ctx.user.role });
      await logAudit(ctx, { action: "contactPerson.update", entityType: "contactPerson", entityId: input.id, newValue: input });
      return res;
    }),

  setInactive: crmWriteProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
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
  /** بحث موحّد عبر عملاء/موردين/أطراف توصيل/مرسلي واتساب غير المربوطين. */
  search: crmReadProcedure
    .input(
      z.object({
        q: z.string().min(1).max(120),
        kinds: z.array(contactKind).min(1).max(4).optional(),
        cursor: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    )
    .query(({ ctx, input }) => searchContacts({ scopedBranchId: ctx.scopedBranchId }, input)),

  /** بطاقة ٣٦٠° لطرف واحد (عميل أو مورّد) — تجميع قراءة فقط، الأرصدة محجوبة لغير المدير. */
  contact360: crmReadProcedure
    .input(z.object({ kind: partyKind, id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const res = await contact360(input);
      if (res.kind === "customer") return { ...res, customer: maskCustomerSensitive(res.customer, ctx.user.role) };
      return { ...res, supplier: maskSupplierSensitive(res.supplier, ctx.user.role) };
    }),

  /** كشف ازدواج للقراءة فقط — لا دمج (v1، قرار موثَّق في duplicates.ts). */
  findDuplicates: crmReadProcedure
    .input(
      z.object({
        kind: partyKind,
        id: z.number().int().positive().optional(),
        name: z.string().max(255).optional(),
        phone: z.string().max(25).optional(),
      }),
    )
    .query(({ input }) => findContactDuplicates(input)),

  waConsent: waConsentRouter,
  persons: personsRouter,
});
