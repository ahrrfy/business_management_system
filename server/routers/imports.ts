// راوتر الاستيراد بالجملة (بيانات أساسية فقط). كله managerProcedure (التكلفة تظهر للمدير فأعلى).
// يُسجَّل في server/routers.ts كـ `imports` عند التكامل (ملف ساخن — مالك الدمج).
import { z } from "zod";
import { logAudit } from "../services/auditService";
import {
  customerImportRow,
  importCustomers,
  importProducts,
  importSuppliers,
  productImportRow,
  supplierImportRow,
  usdRateStr,
  type ImportSummary,
} from "../services/importService";
import { managerProcedure, router } from "../trpc";

const optionsSchema = z
  .object({
    dryRun: z.boolean().default(false),
    onExisting: z.enum(["skip", "update", "error"]).default("skip"),
    fileName: z.string().max(255).optional(),
    // خيارات شريحة تكامل الاستيراد (§٥): سعر صرف USD (موجب حصراً — refine في usdRateStr)،
    // تجاوز الصفوف الفاشلة، واتجاه الرصيد الافتتاحي (الواجهة تقترح «اعكس» للموردين افتراضاً).
    usdRate: usdRateStr.optional(),
    skipFailed: z.boolean().default(false),
    balanceSign: z.enum(["asIs", "invert"]).default("asIs"),
  })
  .optional();

// المنتجات: إنشاء فقط — لا «update» (تحديث شجرة المنتج عبر شاشة المنتج لا الاستيراد).
// لا usdRate/balanceSign هنا (لا أرصدة مالية في المنتجات) — skipFailed يعمل على مستوى المنتج كاملاً (§٥.٤).
const productOptionsSchema = z
  .object({
    dryRun: z.boolean().default(false),
    onExisting: z.enum(["skip", "error"]).default("skip"),
    fileName: z.string().max(255).optional(),
    skipFailed: z.boolean().default(false),
  })
  .optional();

const auditCounts = (s: ImportSummary) => ({
  total: s.total,
  created: s.created,
  updated: s.updated,
  skipped: s.skipped,
  failed: s.failed,
});

export const importRouter = router({
  customers: managerProcedure
    .input(z.object({ rows: z.array(customerImportRow).min(1).max(2000), options: optionsSchema }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 };
      const summary = await importCustomers(input.rows, input.options ?? {}, actor);
      if (summary.committed)
        await logAudit(ctx, { action: "import.customers", entityType: "import", newValue: auditCounts(summary) });
      return summary;
    }),

  suppliers: managerProcedure
    .input(z.object({ rows: z.array(supplierImportRow).min(1).max(2000), options: optionsSchema }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 };
      const summary = await importSuppliers(input.rows, input.options ?? {}, actor);
      if (summary.committed)
        await logAudit(ctx, { action: "import.suppliers", entityType: "import", newValue: auditCounts(summary) });
      return summary;
    }),

  products: managerProcedure
    .input(z.object({ rows: z.array(productImportRow).min(1).max(5000), options: productOptionsSchema }))
    .mutation(async ({ input, ctx }) => {
      const actor = { userId: ctx.user.id, branchId: ctx.user.branchId ?? 1 };
      const summary = await importProducts(input.rows, input.options ?? {}, actor);
      if (summary.committed)
        await logAudit(ctx, { action: "import.products", entityType: "import", newValue: auditCounts(summary) });
      return summary;
    }),
});
