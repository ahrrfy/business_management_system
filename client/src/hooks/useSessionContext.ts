/**
 * useSessionContext.ts — قِراءةُ ما يعرفه الخادم عن هذه الجلسة، لا اختراعُ افتراضاتٍ مكانه.
 *
 * الغرض: يُغذّي `<InferredField>` بالمُشتَقّ الخادميّ للفرع النشط: **من ينسب** إليه هذا
 * المستخدمُ عمله (`me.branchId`)، وهل يستطيع تجاوزَه شرعياً (`canCrossBranches`). المصدر
 * الوحيد للحقيقة هنا هو ما تُرجعه `trpc.auth.me` — الشاشةُ لا تُنشئ فرعاً من العدم، ولا تختار
 * الفرع ١ حين لا فرعَ مُسنَد؛ تلك الفجوةُ هي بابُ IDOR التاريخيّ الذي يحرسه `check:branch`.
 *
 * ⚠️ **ليس نظير `composeSessionContext` الخادميّ.** هذا الملفّ **يقرأ للعرض** فقط:
 *   • لا يبني `SessionContext` بحمولةٍ ملفَّقة على العميل (`allowedPaymentMethods`،
 *     `businessDay` الخ ليست في `auth.me`).
 *   • الإنفاذُ النهائيّ يبقى خادمياً (§٢ من `CLAUDE.md`): `branchScopedProcedure` يحقن
 *     `scopedBranchId` بنفسه ويرفض ما لا يُطابقه للعميل غير عابر الفروع.
 *   • الوقتُ الوحيد لـ«ادّعاءٍ» عميليّ على `branchId` هو المرور بـ`assertMatchesDerived` من
 *     `shared/sessionContext.ts` بحمولةٍ **خادمية** — وذلك مسارُ متابعةٍ عبر
 *     `sessionContextRouter.derive` لا يجوز أن يقفزه هذا الهوك.
 *
 * ⛔ **لا افتراض `?? 1`**: أدمنٌ بلا فرعٍ مُسنَد ⇒ `status: 'unassigned'` — الشاشةُ تفتح قائمةَ
 *   فروعٍ خادميّة للاختيار، ولا تسقط على الفرع ١ صامتاً (نمطُ IDOR الذي كسر تدفّقاتٍ ماليّة).
 *
 * قاعدةُ عبور الفروع = مرآةُ `server/lib/branchAuthority.ts` سطراً بسطر: `admin || isOwner`.
 * تُكرَّر هنا بلا استيراد (اتّجاه الطبقات `server → client` ممنوع في الحزم المشتركة العميليّة).
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import type { SessionBranch } from "@shared/sessionContext";

/**
 * حالةُ الاستنتاج — أربعُ حالاتٍ متبادلةُ الاستبعاد، فكلٌّ منها له عرضٌ مختلفٌ في `<InferredField>`:
 *  • `loading`: الجلسة تُقرَأ الآن — شارةُ تحميلٍ لا حقلٌ فارغٌ مربك.
 *  • `resolved`: فرعٌ مُسنَد وقُرئ اسمُه — الحالةُ السعيدة (٦٩ إجراءً يعرف الخادمُ فرعَها أصلاً).
 *  • `unassigned`: فاعلٌ عابرُ الفروع (`admin`/`isOwner`) بلا فرعٍ مُسنَد — يجب أن يختار من قائمة
 *    فروع؛ لا فرعَ افتراضيّ. ولا تُصنَّف حالةُ خطأ لأنّها مسارٌ مشروع خادمياً.
 *  • `error`: تعذّرت قراءةُ الجلسة (لم يوجد `me` أو ردّ الخادم `null`) — رسالةٌ عمليّة بمخرج،
 *    لا حقلٌ فارغٌ صامت.
 */
export type SessionBranchInferenceStatus =
  | "loading"
  | "resolved"
  | "unassigned"
  | "error";

export interface SessionBranchInference {
  status: SessionBranchInferenceStatus;
  /** معرّفُ الفرع النشط، أو `null` حين لا فرعَ نشطاً (`unassigned` / `loading` / `error`). */
  branchId: number | null;
  /** اسمُ الفرع كما هو في قاعدة البيانات — نصٌّ عربيّ (لا يُلفَّق من ID). */
  branchName: string | null;
  /**
   * هل يستطيع هذا الفاعلُ تجاوزَ الفرع النشط باختيارٍ صريح؟ — `admin || isOwner` حصراً.
   * غيرُ عابر الفروع لا يرى زرَّ التغيير، والقيمة تُرسَل للخادم كما هي وتُرفَض تلقائياً هناك.
   */
  canOverride: boolean;
  /** فروعُ الاختيار حين يفتح المستخدمُ قائمةَ التغيير (تُحمَّل كسولةً كي لا نُثقل الشاشة). */
  branches: readonly SessionBranch[];
  /**
   * تسمية عربية قصيرة تشرح **مصدر** القيمة المعروضة — «فرعك المُسنَد» أو «مختار» أو غيرها،
   * تظهر تحت أو بجانب القيمة، فالموظّف يعرف لماذا يرى ما يراه.
   */
  sourceLabel: string;
  /**
   * رسالةٌ للمشكلة الحاليّة (فقط في `error` أو `unassigned` حين تُعرض بلا اختيار بعد). صيغةُ
   * «ماذا حدث · لماذا · ماذا تفعل الآن» (عقدُ الأخطاء في `shared/errors.ts`).
   */
  message: string | null;
}

/**
 * قاعدةُ عبور الفروع — مرآةٌ حرفيّة لـ`server/lib/branchAuthority.ts`. الإنفاذُ النهائيّ خادميّ:
 * هذا الملف يقرأ الحقلَ نفسه (`isOwner`) الذي طبَّعه `normalizeOwnerAuthority` قبل التوقيع
 * وأرسله في `auth.me`، فلا مسربَ لسقفٍ مرفوعٍ من الواجهة.
 */
function inferCanCrossBranches(me: {
  role?: string | null;
  isOwner?: boolean | null;
}): boolean {
  return me.role === "admin" || me.isOwner === true;
}

/**
 * هوكُ استنتاج الفرع النشط. يُستدعى داخل `<InferredField>` لكن يمكن استعمالُه في كلّ شاشةٍ
 * تحتاج فرعاً افتراضياً — بلا تكرار للمنطق ولا لخريطة الأدوار.
 *
 * يحمي من ثلاث ألغام:
 *   ١) قراءةُ `branchId` قبل انتهاء `me.isLoading` تُنتج `undefined`؛ نرفع `loading` صراحةً.
 *   ٢) `me.data === null` (توكن ساقط) لا يجوز أن يُعطي فرعاً؛ نرفع `error` بمخرج «سجّل الدخول».
 *   ٣) أدمن بلا `branchId` ← `unassigned` لا `?? 1` (بابُ IDOR).
 */
export function useSessionBranchInference(): SessionBranchInference {
  const me = trpc.auth.me.useQuery(undefined, {
    // البيانات مستقرّةٌ طوال الجلسة؛ إعادةُ الجلب مع كلّ mount تُنتج وميضاً في الشاشات المتعدّدة.
    staleTime: 60_000,
  });

  // قائمةُ الفروع لا نطلبها إلّا حين نحتاج اسمَ الفرع أو نفتح قائمةَ التغيير — فحوّاف `enabled`
  // تمنع طلبَها لمستخدم عابرٍ يفتح شاشةً لا تحتاجها. (اسم الفرع = بشرٌ يفهم، لا رقمٌ يخترعه.)
  const branchesQ = trpc.branches.list.useQuery(undefined, {
    enabled: me.data != null,
    staleTime: 60_000,
  });

  return useMemo<SessionBranchInference>(() => {
    if (me.isLoading) {
      return emptyInference("loading", null);
    }
    if (me.isError || !me.data) {
      return emptyInference(
        "error",
        "تعذّرت قراءةُ جلستك · انتهت أو لم تُقبل · سجّل الدخول ثمّ حاول مجدّداً.",
      );
    }

    const canOverride = inferCanCrossBranches(me.data);
    const assignedId =
      typeof me.data.branchId === "number" && me.data.branchId > 0
        ? me.data.branchId
        : null;

    // Codex #958: فشلُ `branches.list` كان يُطوى صامتاً إلى `[]` فيُعرَض للأدمن/المالك
    // منتقياً فارغاً بلا سببٍ ولا مسار استعادة، ونماذجُ المصروف والجرد لا تُكمَل. الآن
    // نُميّز الفشل الحيّ (وليس مجرَّد «لا شيءَ لعرضه») فنُظهره حالةَ خطأٍ صريحةً بمسار إعادة
    // محاولة. الأدمن/المالك بلا فرعٍ مُسنَد يعتمد على القائمة اعتماداً كاملاً؛ الموظّفُ الذي
    // له `assignedId` قد يستمرّ بلا اسمٍ (يظهر «فرع #N») لأنّ الاسمَ زخرفٌ لا حاجزٌ للحفظ.
    if (branchesQ.isLoading) {
      return emptyInference("loading", null);
    }
    const branchesFailed = branchesQ.isError && !branchesQ.data;
    if (branchesFailed && assignedId == null) {
      return emptyInference(
        "error",
        "تعذّرت قراءةُ قائمة الفروع · شبكةٌ أو خادمٌ لم يستجب · انقر «إعادة المحاولة» أو حدّث الصفحة.",
      );
    }

    // قائمةُ الفروع للعرض — تُنقّى إلى ما يفهمه `SessionBranch` (id + name فقط) كي لا يعتمد
    // `<InferredField>` على شكلِ صفّ `branches` بأعمدته الكاملة (isActive/type/…) — فتغيّر
    // ذلك الصفّ خادمياً لا يكسر مستهلكاً هنا.
    const branches: readonly SessionBranch[] =
      branchesQ.data
        ?.map((b): SessionBranch => ({ id: b.id, name: b.name }))
        .filter((b) => b.id > 0 && b.name.trim().length > 0) ?? [];

    if (assignedId != null) {
      const branch = branches.find((b) => b.id === assignedId) ?? null;
      return {
        status: "resolved",
        branchId: assignedId,
        // إن لم نجد الفرعَ في القائمة (سباقُ تحميل، أو الفرع مُعطَّل) نُعرَض بالرقم فقط بلا
        // اسمٍ مخترع — بشرُ الشاشة يرى «فرع #٢» بدل اسمٍ خاطئ يُوهم الملكية.
        branchName: branch?.name ?? null,
        canOverride,
        branches,
        sourceLabel: "فرعك المُسنَد",
        message: null,
      };
    }

    if (canOverride) {
      // أدمنٌ/مالكٌ بلا فرعٍ مُسنَد ⇒ يُسمَح له بالاختيار، لكن **لا يُختار له افتراضاً**.
      return {
        status: "unassigned",
        branchId: null,
        branchName: null,
        canOverride: true,
        branches,
        sourceLabel: "لا فرعَ مُسنَد",
        message:
          "حسابك بلا فرعٍ مُسنَد · لا يستطيع النظامُ اختيارَه عنك · اختر الفرعَ من القائمة قبل الحفظ.",
      };
    }

    // غيرُ عابر الفروع بلا فرعٍ مُسنَد = حالةٌ مستحيلةٌ خادمياً (الراوترُ يرفضها بـFORBIDDEN)،
    // لكنّها تظهر تحت `auth.me` في نافذةٍ ضيّقة (توقفُ ثانيةٍ بين تعطيل الفرع وإنهاء الجلسة).
    // نُعامَل كخطأ صريح لا حقلٍ فارغ ⇒ الرسالةُ عمليّة: تواصل مع المدير.
    return {
      status: "error",
      branchId: null,
      branchName: null,
      canOverride: false,
      branches,
      sourceLabel: "لا فرعَ مُسنَد",
      message:
        "حسابك بلا فرعٍ مُسنَد · لا يمكن العملُ بلا فرع · اطلب من المدير إسنادَ فرعٍ لك ثم أعِد التحميل.",
    };
  }, [me.isLoading, me.isError, me.data, branchesQ.data]);
}

function emptyInference(
  status: Extract<SessionBranchInferenceStatus, "loading" | "error">,
  message: string | null,
): SessionBranchInference {
  return {
    status,
    branchId: null,
    branchName: null,
    canOverride: false,
    branches: [],
    sourceLabel: status === "loading" ? "" : "لا فرعَ نشط",
    message,
  };
}
