import { z } from "zod";

/**
 * مخطط عنصر استبدال مادة خام في أمر تشغيل/وصفة.
 */
export const materialSubstitutionItemSchema = z
  .object({
    originalVariantId: z.number().int().positive("معرف المادة الأصلية غير صالح"),
    substituteVariantId: z.number().int().positive("معرف المادة البديلة غير صالح"),
    substituteProductUnitId: z.number().int().positive().nullish(),
    qtyPerOutputBase: z
      .string()
      .trim()
      .regex(/^\d+(\.\d{1,4})?$/, "الكمية يجب أن تكون رقماً موجباً بأربع منازل عشرية كحد أقصى")
      .refine((v) => Number(v) > 0, "الكمية يجب أن تكون أكبر من صفر"),
  })
  .refine((data) => data.originalVariantId !== data.substituteVariantId, {
    message: "المادة البديلة لا يمكن أن تكون نفس المادة الأصلية",
    path: ["substituteVariantId"],
  });
export type MaterialSubstitutionItem = z.infer<typeof materialSubstitutionItemSchema>;

/**
 * مخطط مدخلات الاستبدال الدائم لمادة في وصفة إنتاج مع الحفظ الذري.
 */
export const substituteRecipeMaterialInputSchema = z
  .object({
    recipeId: z.number().int().positive("معرف الوصفة غير صالح"),
    originalVariantId: z.number().int().positive("معرف المادة الأصلية غير صالح"),
    substituteVariantId: z.number().int().positive("معرف المادة البديلة غير صالح"),
    substituteProductUnitId: z.number().int().positive().nullish(),
    qtyPerOutputBase: z
      .preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim() : v),
        z
          .string()
          .regex(/^\d+(\.\d{1,4})?$/, "الكمية يجب أن تكون رقماً موجباً بأربع منازل عشرية كحد أقصى")
          .refine((v) => Number(v) > 0, "الكمية يجب أن تكون أكبر من صفر")
          .nullish(),
      ),
    notes: z.string().max(500, "الملاحظة لا تتجاوز 500 حرف").nullish(),
    reason: z.string().max(255, "سبب الاستبدال لا يتجاوز 255 حرفاً").nullish(),
    branchId: z.number().int().positive().nullish(),
  })
  .refine((data) => data.originalVariantId !== data.substituteVariantId, {
    message: "المادة البديلة لا يمكن أن تكون نفس المادة الأصلية",
    path: ["substituteVariantId"],
  });
export type SubstituteRecipeMaterialInput = z.infer<typeof substituteRecipeMaterialInputSchema>;

/**
 * نتيجة الاستبدال الذري لمادة الوصفة.
 */
export interface SubstituteRecipeMaterialResult {
  success: boolean;
  recipeId: number;
  originalVariantId: number;
  substituteVariantId: number;
  qtyPerOutputBase: string;
  recipeName: string;
  outputVariantId: number;
  auditLogged: boolean;
  noteRecorded: boolean;
}
