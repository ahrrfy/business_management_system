/**
 * **راوترُ منتقي روافد الردّ الموحَّد** — `preflight` بلا كتابةٍ ولا فعلٍ ماليّ.
 *
 * الاستفتاءُ الوحيد الذي يخدمه هذا الراوتر: «حين أردّ من هذا المستند، ما القوائم المتاحة
 * وأرصدتها والاستثناءات؟». الفعلُ الماديّ (`cancel`, `reverseDelivery`, `returnConsignment`
 * …) يبقى مع راوتر الوحدة المالكة كما هو — ولا يُوسَّع سطحُ الكتابة من هنا (§٥).
 *
 * ⚠️ **بوّابةُ الوصول = `treasury:READ`**: الاستفتاءُ يقرأ رصيدَ درج الوردية والخزينة
 * ومراجعَ البطاقة — ثلاثةُ سطوحٍ منطقةُ وحدةٍ واحدة (الخزينة والمدفوعات). الفعلُ الماديّ
 * يبقى مع راوتر الوحدة المالكة للمستند (cancel/reverseDelivery/returnConsignment)، أمّا
 * القراءةُ فتُنسَب لأصلِ البيانات المقروءة. هذا يتوافق مع حارس `authz-guard-diff` (كلّ
 * إجراءٍ جديد يلزمه بوّابةُ وحدة)، ولا يمنع الاستقبالَ من استفتاءِ إرجاع الإرسالية لأنّ
 * الكاشير عندهم `treasury:READ` بالسياسة القائمة. عزلُ الفرع + حجبُ الرصيد يظلّان في
 * الخدمة كضبطٍ ثانٍ مختبَر (`refundRailService.test.ts`).
 */
import { protectedProcedure, requireModule, router } from "../trpc";
import { withTx } from "../services/tx";
import { refundRailPreflight } from "../services/refundRailService";
import { RefundRailContextSchema } from "@shared/refundRails";
import type { PermissionMap } from "@shared/permissions";

/** بوّابةُ القراءة على وحدة الخزينة — تُنشأ مرّةً وتُعاد استعمالها بحسب النمط في المستودع. */
const refundReadProcedure = protectedProcedure.use(requireModule("treasury", "READ"));

export const refundRailsRouter = router({
  /**
   * **الاستفتاءُ الموحَّد** — يُرجِع `RefundPreflight` بالضبط الذي يستهلكه المكوّن
   * `<RefundRailPicker>` — بلا تحويلٍ للأشكال بين الطرفين.
   */
  preflight: refundReadProcedure
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
