import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { importExportService, ImportEntityType } from "../services/importExportService";

export const importExportRouter = router({
  /**
   * الحصول على الأعمدة المتوقعة لنوع معين
   */
  getExpectedColumns: publicProcedure
    .input(z.object({ entityType: z.enum(["products", "customers", "suppliers"]) }))
    .query(({ input }) => {
      return importExportService.getExpectedColumns(input.entityType as ImportEntityType);
    }),

  /**
   * مطابقة الأعمدة الذكية
   */
  smartMapping: protectedProcedure
    .input(
      z.object({
        headers: z.array(z.string()),
        entityType: z.enum(["products", "customers", "suppliers"]),
      })
    )
    .mutation(async ({ input }) => {
      return importExportService.smartColumnMapping(input.headers, input.entityType as ImportEntityType);
    }),

  /**
   * التحقق من صحة البيانات
   */
  validate: protectedProcedure
    .input(
      z.object({
        data: z.array(z.record(z.string(), z.any())),
        entityType: z.enum(["products", "customers", "suppliers"]),
        columnMappings: z.array(
          z.object({
            sourceColumn: z.string(),
            targetField: z.string(),
            confidence: z.number(),
          })
        ),
      })
    )
    .mutation(async ({ input }) => {
      return await importExportService.validateImportData(
        input.data,
        input.entityType as ImportEntityType,
        input.columnMappings
      );
    }),

  /**
   * تنفيذ الاستيراد
   */
  executeImport: protectedProcedure
    .input(
      z.object({
        data: z.array(z.record(z.string(), z.any())),
        entityType: z.enum(["products", "customers", "suppliers"]),
        columnMappings: z.array(
          z.object({
            sourceColumn: z.string(),
            targetField: z.string(),
            confidence: z.number(),
          })
        ),
        skipDuplicates: z.boolean().default(true),
      })
    )
    .mutation(async ({ input }) => {
      return await importExportService.executeImport(
        input.data,
        input.entityType as ImportEntityType,
        input.columnMappings,
        input.skipDuplicates
      );
    }),

  /**
   * تصدير البيانات
   */
  exportData: protectedProcedure
    .input(z.object({ entityType: z.enum(["products", "customers", "suppliers"]) }))
    .query(async ({ input }) => {
      return await importExportService.exportData(input.entityType as ImportEntityType);
    }),
});
