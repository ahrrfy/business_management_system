/**
 * **راوترُ منتقي روافد الردّ الموحَّد** — `preflight` بلا كتابةٍ ولا فعلٍ ماليّ.
 *
 * الاستفتاءُ الوحيد الذي يخدمه هذا الراوتر: «حين أردّ من هذا المستند، ما القوائم المتاحة
 * وأرصدتها والاستثناءات؟». الفعلُ الماديّ (`cancel`, `reverseDelivery`, `returnConsignment`
 * …) يبقى مع راوتر الوحدة المالكة كما هو — ولا يُوسَّع سطحُ الكتابة من هنا (§٥).
 *
 * ⚠️ **بوّابةُ الوصول = `protectedProcedure`** لا وحدةٌ بعينها: النوعُ في الحمولة هو الذي
 * يحدّد أيَّ وحدةٍ يقصد الفاعل، والخدمةُ تُنفّذ العزلَ الفرعيّ + حجبَ الرصيد بحسب دور الفاعل
 * وبصمته. رفعُ البوّابة إلى وحدةٍ واحدة (مثل `workorders:FULL`) كان سيمنع الاستقبالَ من
 * استفتاءِ إرجاع إرسالية توصيلٍ صالحٍ عنده، ورفعُها إلى «تجميعِ» وحدات يُعقّد الحرّاسَ بلا
 * أن يزيد أماناً — فعزلُ الفرع في الخدمة كافٍ ومختبَر (`refundRailService.test.ts`).
 */
import { protectedProcedure, router } from "../trpc";
import { withTx } from "../services/tx";
import { refundRailPreflight } from "../services/refundRailService";
import { RefundRailContextSchema } from "@shared/refundRails";
import type { PermissionMap } from "@shared/permissions";

export const refundRailsRouter = router({
  /**
   * **الاستفتاءُ الموحَّد** — يُرجِع `RefundPreflight` بالضبط الذي يستهلكه المكوّن
   * `<RefundRailPicker>` — بلا تحويلٍ للأشكال بين الطرفين.
   */
  preflight: protectedProcedure
    .input(RefundRailContextSchema)
    .query(({ input, ctx }) =>
      withTx((tx) =>
        refundRailPreflight(tx, input, {
          userId: ctx.user.id,
          branchId: Number(ctx.user.branchId ?? 0),
          role: ctx.user.role,
          isOwner: ctx.user.isOwner === true,
          permissionsOverride: (ctx.user.permissionsOverride ?? null) as PermissionMap | null,
        }),
      ),
    ),
});
