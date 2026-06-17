/**
 * router البحث الشامل — نقطة دخول واحدة (`globalSearch.search`) تُوزِّع
 * الاستعلام على كل وحدات النظام بعد تصنيف نمطه (باركود/مُعرّف/هاتف/نص).
 *
 * RBAC + عزل الفرع: يجريان داخل الخدمة (`globalSearchService.globalSearch`)
 * اعتماداً على `ctx.user.role` و`ctx.user.branchId` ⇒ الراوتر رقيق جداً.
 */

import { z } from "zod";
import { protectedProcedure, router } from "../trpc";
import { globalSearch, type SearchEntityType } from "../services/globalSearchService";

const ENTITY_TYPES = [
  "PRODUCT",
  "INVOICE",
  "QUOTATION",
  "PURCHASE_ORDER",
  "WORK_ORDER",
  "CUSTOMER",
  "SUPPLIER",
  "EXPENSE",
] as const satisfies readonly SearchEntityType[];

export const globalSearchRouter = router({
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().max(200),
        scopes: z.array(z.enum(ENTITY_TYPES)).optional(),
        perEntityLimit: z.number().int().min(1).max(20).default(6),
      }),
    )
    .query(({ input, ctx }) =>
      globalSearch({
        query: input.query,
        branchId: ctx.user.branchId ?? null,
        role: ctx.user.role,
        perEntityLimit: input.perEntityLimit,
        scopes: input.scopes,
      }),
    ),
});
