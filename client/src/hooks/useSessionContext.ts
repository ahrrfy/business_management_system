/**
 * useSessionContext.ts — قِراءةُ ما يعرفه الخادم عن هذه الجلسة، لا اختراعُ افتراضاتٍ مكانه.
 *
 * (م٤ ق١ — الاستنتاج قبل السؤال) المصدرُ الوحيد للحقيقة هنا هو `sessionContext.get`
 * (server/routers/sessionContextRouter.ts): يعيد `SessionContext` مركَّباً على الخادم عبر
 * `composeSessionContext` — الفرعُ النشط باسمه · اليومُ التشغيليّ (بغداد) · طرقُ القبض ·
 * الفئةُ السعرية الافتراضية · سلطةُ العبور · نطاقُ الرؤية — مع قائمةِ الفروع القابلة للاختيار.
 * كان هذا الهوك يبني الاستنتاجَ من `auth.me` + `branches.list` على العميل؛ صار يعرض المُشتَقَّ
 * الخادميّ وحده.
 *
 * قواعدُ الهوك (كلٌّ منها يغلق باباً حقيقياً):
 *   ١) **يفشل مغلقاً**: الحمولةُ تمرّ بـ`readSessionContext` (shared/sessionContext.ts) فأيّ حقلٍ
 *      ناقصٍ أو متناقض ⇒ `status: "error"` برسالةٍ عمليّة، لا سياقٌ نصفُه مخترَع.
 *   ٢) ⛔ **لا `?? 1`**: أدمنٌ/مالكٌ بلا فرعٍ مُسنَد ⇒ `unassigned` — الشاشةُ تعرض قائمةَ فروعٍ
 *      خادميّة (`selectableBranches`) للاختيار، ولا تسقط على الفرع ١ صامتاً (بابُ IDOR الذي
 *      يحرسه `check:branch`).
 *   ٣) **يبطل عند تغيّر الجلسة أو الفرع**: مفتاحُ الاستعلام واحدٌ لكلّ الشاشات (بلا مُدخَل — الخادم
 *      لا يقبل معرّفَ مستخدمٍ من العميل)، فتُراقَب هويّةُ `auth.me` (المستخدم · الفرع · الدور ·
 *      الملكية) ويُبطَل السياقُ المخبَّأ حين تتبدّل، ويُمسَح عند الخروج كي لا يقرأ الداخلُ
 *      التالي سياقَ سلفه.
 *   ٤) **الإنفاذُ النهائيّ خادميّ** (§٢): هذا الملفّ يقرأ للعرض ولإزالة إغراء الاختراع فقط؛
 *      `branchScopedProcedure` يحقن `scopedBranchId` بنفسه ويرفض ما لا يُطابقه.
 */
import { useEffect, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import {
  readSessionContext,
  type SessionBranch,
  type SessionContext,
} from "@shared/sessionContext";

export type SessionContextStatus = "loading" | "ready" | "error";

export interface SessionContextState {
  status: SessionContextStatus;
  /** السياقُ الموثَّق (بعد `readSessionContext`) — `null` ما لم تكن الحالة `ready`. */
  context: SessionContext | null;
  /** الفروعُ التي يجوز اختيارُها صراحةً — قائمةٌ خادميّة تتبع سلطةَ الفاعل (لا `branches.list` العامّة). */
  selectableBranches: readonly SessionBranch[];
  /** رسالةٌ عمليّة بصيغة «ماذا حدث · لماذا · ماذا تفعل» — في `error` فقط. */
  message: string | null;
  /** إعادةُ القراءة من الخادم — مخرجُ حالة الخطأ. */
  retry: () => void;
}

/** البيانات مستقرّةٌ طوال الجلسة؛ إعادةُ الجلب مع كلّ تركيبٍ تُنتج وميضاً في الشاشات المتعدّدة. */
const SESSION_CONTEXT_STALE_MS = 60_000;

const SIGN_IN_MESSAGE =
  "تعذّرت قراءةُ جلستك · انتهت أو لم تُقبل · سجّل الدخول ثمّ حاول مجدّداً.";
const UNREADABLE_PAYLOAD_MESSAGE =
  "حمولةُ الجلسة غير مكتملة · ردُّ الخادم لا يطابق عقد السياق · حدّث الصفحة، وإن تكرّر أبلغ الدعم.";
const NETWORK_MESSAGE =
  "تعذّرت قراءةُ سياق جلستك · شبكةٌ أو خادمٌ لم يستجب · انقر «إعادة المحاولة» أو حدّث الصفحة.";
const NO_BRANCH_MESSAGE =
  "حسابك بلا فرعٍ مُسنَد · لا يمكن العملُ بلا فرع · اطلب من المدير إسنادَ فرعٍ لك ثم أعِد التحميل.";
const UNASSIGNED_MESSAGE =
  "حسابك بلا فرعٍ مُسنَد · لا يستطيع النظامُ اختيارَه عنك · اختر الفرعَ من القائمة قبل الحفظ.";

/** بصمةُ الجلسة التي يُبطَل السياقُ عند تبدّلها — لا تحمل قيمةً تُعرض، بل تُقارَن فقط. */
function identityOf(
  me:
    | { id: number; branchId?: number | null; role?: string | null; isOwner?: boolean | null }
    | null
    | undefined,
): string | null {
  if (!me) return null;
  return `${me.id}:${me.branchId ?? "-"}:${me.role ?? "-"}:${me.isOwner ? 1 : 0}`;
}

/**
 * رسالةُ الخطأ للعرض. رسائلُ الخادم الحديثة تحمل «ماذا تفعل» بنفسها (عقد `shared/errors.ts`)
 * فتُعرَض كما هي؛ ورفضُ `branchScopedProcedure` القديم («لا فرع مُسنَد لهذا المستخدم») صمّاء،
 * فتُترجَم إلى مخرجٍ عمليّ بدل أن تقف عند السبب.
 */
function describeContextError(
  error: { message?: string; data?: { code?: string } | null } | null | undefined,
): string {
  const code = error?.data?.code;
  if (code === "UNAUTHORIZED") return SIGN_IN_MESSAGE;
  const message = error?.message?.trim() ?? "";
  if (code === "FORBIDDEN" && message.includes("لا فرع مُسنَد لهذا المستخدم")) {
    return NO_BRANCH_MESSAGE;
  }
  return message || NETWORK_MESSAGE;
}

/**
 * أيُّ استعلامٍ يُعاد جلبه عند «إعادة المحاولة»؟ — مسندٌ نقيّ لاختبار الحافّة بلا React.
 *
 * العطبُ الذي يغلقه (تدقيق Codex، م٤): الزرّ كان يُعيد جلبَ `sessionContext.get` وحده. لكنّ ذلك
 * الاستعلام **مُعطَّلٌ** (`enabled: signedIn`) ما لم تُقرأ الهويّة؛ فإن فشل `auth.me` ابتدائياً بقيَ
 * `meError`/`signedIn===false` وظلّت الشاشاتُ الثلاث محجوبةً ولو نجحت إعادةُ جلب السياق. المخرج:
 * حين يكون الساقطُ هو الهويّة، نُعيد جلبَ `me` أوّلاً — ومتى قُرئت الهويّةُ فعّلت استعلامَ السياق
 * فجُلب تلقائياً؛ وإلّا فالسياقُ هو الساقط فنُعيد جلبَه مباشرةً.
 */
export function retryTarget(opts: {
  meError: boolean;
  signedIn: boolean;
}): "me" | "context" {
  return opts.meError || !opts.signedIn ? "me" : "context";
}

/**
 * سياقُ الجلسة كما اشتقّه الخادم — للشاشات التي تحتاج أكثر من الفرع (اليوم التشغيليّ، طرق القبض،
 * الفئة السعرية، سلطة العبور). يُستدعى من أيّ شاشة؛ الاستعلامُ مشترَكٌ ومخبَّأ.
 */
export function useSessionContext(): SessionContextState {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery(undefined, { staleTime: SESSION_CONTEXT_STALE_MS });
  const identity = identityOf(me.data);
  const signedIn = identity != null;

  const contextQuery = trpc.sessionContext.get.useQuery(undefined, {
    enabled: signedIn,
    staleTime: SESSION_CONTEXT_STALE_MS,
    // FORBIDDEN/PRECONDITION_FAILED لا تتغيّر بإعادة المحاولة الآليّة؛ المخرجُ زرُّ «إعادة المحاولة».
    retry: false,
  });

  // (٣) الإبطالُ عند تبدّل الهويّة — يُقارَن بالهويّة **السابقة** لا بالتركيب الأوّل: إبطالٌ عند كلّ
  // تركيبٍ كان سيُلغي الجلبَ الجاري ويُعيده (طلبان لكلّ شاشة) ويُبطل `staleTime`.
  const previousIdentity = useRef<string | null>(identity);
  useEffect(() => {
    const previous = previousIdentity.current;
    if (previous === identity) return;
    previousIdentity.current = identity;
    // أوّلُ وصولٍ للهويّة: الاستعلامُ يُفعَّل ويُجلَب طبيعياً — لا إبطال.
    if (previous == null) return;
    if (identity == null) {
      // خروج: يُمسَح كي لا يقرأ الداخلُ التالي سياقَ سلفه من الذاكرة.
      void utils.sessionContext.get.reset();
    } else {
      void utils.sessionContext.get.invalidate();
    }
  }, [identity, utils]);

  const refetch = contextQuery.refetch;
  const meRefetch = me.refetch;
  const { isLoading: meLoading, isError: meError } = me;
  const { isPending, isError, error, data } = contextQuery;

  return useMemo<SessionContextState>(() => {
    const retry = () => {
      // نُعيد جلبَ الاستعلام الذي فشل فعلاً: `me` حين تسقط الهويّة (وإلّا بقيت الشاشاتُ محجوبةً
      // ولو نجح السياق — راجع `retryTarget`)، والسياقَ حين تكون الهويّةُ حاضرةً وهو الساقط.
      if (retryTarget({ meError, signedIn }) === "me") {
        void meRefetch();
      } else {
        void refetch();
      }
    };
    const failed = (message: string): SessionContextState => ({
      status: "error",
      context: null,
      selectableBranches: [],
      message,
      retry,
    });
    const loading: SessionContextState = {
      status: "loading",
      context: null,
      selectableBranches: [],
      message: null,
      retry,
    };

    if (meLoading) return loading;
    if (meError || !signedIn) return failed(SIGN_IN_MESSAGE);
    if (isPending) return loading;
    if (isError) return failed(describeContextError(error));

    // (١) يفشل مغلقاً: حمولةٌ لا يقبلها العقدُ المشترك لا تصير سياقاً نصفُه مخترَع.
    const context = readSessionContext(data.context);
    if (!context) return failed(UNREADABLE_PAYLOAD_MESSAGE);

    return {
      status: "ready",
      context,
      selectableBranches: data.selectableBranches,
      message: null,
      retry,
    };
  }, [meLoading, meError, signedIn, isPending, isError, error, data, refetch, meRefetch]);
}

/**
 * حالةُ استنتاج الفرع — أربعُ حالاتٍ متبادلةُ الاستبعاد، فكلٌّ منها له عرضٌ مختلفٌ في `<InferredField>`:
 *  • `loading`: الجلسة تُقرَأ الآن — شارةُ تحميلٍ لا حقلٌ فارغٌ مربك.
 *  • `resolved`: فرعٌ مُسنَد وقُرئ اسمُه من الخادم — الحالةُ السعيدة.
 *  • `unassigned`: فاعلٌ عابرُ الفروع (`admin`/`isOwner`) بلا فرعٍ مُسنَد — يجب أن يختار من قائمة
 *    فروعٍ خادميّة؛ لا فرعَ افتراضيّ. ولا تُصنَّف حالةَ خطأ لأنّها مسارٌ مشروع خادمياً.
 *  • `error`: تعذّرت قراءةُ الجلسة (توكن ساقط، حمولةٌ ناقصة، أو رفضُ الخادم) — رسالةٌ عمليّة
 *    بمخرج، لا حقلٌ فارغٌ صامت.
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
   * هل يستطيع هذا الفاعلُ تجاوزَ الفرع النشط باختيارٍ صريح؟ — `canCrossBranches` كما اشتقّها
   * الخادم (admin/isOwner). غيرُ عابر الفروع لا يرى زرَّ التغيير، وما يُرسله يُرفَض خادمياً.
   */
  canOverride: boolean;
  /** فروعُ الاختيار الخادميّة: كلُّ النشطة لعابر الفروع، وفرعُه وحده لغيره. */
  branches: readonly SessionBranch[];
  /**
   * تسمية عربية قصيرة تشرح **مصدر** القيمة المعروضة — «فرعك المسند» أو «مختار» أو غيرها،
   * تظهر بجانب القيمة فيعرف الموظّف لماذا يرى ما يراه. (بلا تشكيل: تُرسَم صغيرةً فيُقرأ
   * «مُسنَد» «فسند» — درسُ حارس `check:tashkeel`.)
   */
  sourceLabel: string;
  /**
   * رسالةٌ للمشكلة الحاليّة (فقط في `error` أو `unassigned` حين تُعرض بلا اختيار بعد). صيغةُ
   * «ماذا حدث · لماذا · ماذا تفعل الآن» (عقدُ الأخطاء في `shared/errors.ts`).
   */
  message: string | null;
  /** إعادةُ قراءة السياق من الخادم — مخرجُ حالة الخطأ (زرُّ «إعادة المحاولة»). */
  retry: () => void;
}

/**
 * هوكُ استنتاج الفرع النشط. يُستدعى داخل `<InferredField>` لكن يمكن استعمالُه في كلّ شاشةٍ
 * تحتاج فرعاً افتراضياً — بلا تكرار للمنطق ولا لخريطة الأدوار (كلاهما خادميّ الآن).
 *
 * يحمي من ثلاث ألغام:
 *   ١) قراءةُ `branchId` قبل وصول السياق تُنتج `undefined`؛ نرفع `loading` صراحةً.
 *   ٢) جلسةٌ ساقطة أو حمولةٌ ناقصة لا يجوز أن تُعطي فرعاً؛ نرفع `error` بمخرج.
 *   ٣) أدمن بلا `branchId` ← `unassigned` لا `?? 1` (بابُ IDOR).
 */
export function useSessionBranchInference(): SessionBranchInference {
  const session = useSessionContext();

  return useMemo<SessionBranchInference>(() => {
    const { retry } = session;
    if (session.status === "loading") return emptyInference("loading", null, retry);
    if (session.status === "error" || !session.context) {
      return emptyInference("error", session.message, retry);
    }

    const { context, selectableBranches: branches } = session;
    if (context.branch) {
      return {
        status: "resolved",
        branchId: context.branch.id,
        branchName: context.branch.name,
        canOverride: context.canCrossBranches,
        branches,
        sourceLabel: "فرعك المسند",
        message: null,
        retry,
      };
    }

    if (context.canCrossBranches) {
      // أدمنٌ/مالكٌ بلا فرعٍ مُسنَد ⇒ يُسمَح له بالاختيار، لكن **لا يُختار له افتراضاً**.
      return {
        status: "unassigned",
        branchId: null,
        branchName: null,
        canOverride: true,
        branches,
        sourceLabel: "لا فرع مسند",
        message: UNASSIGNED_MESSAGE,
        retry,
      };
    }

    // غيرُ عابر الفروع بلا فرعٍ مُسنَد = حالةٌ مستحيلةٌ خادمياً (الراوترُ يرفضها بـFORBIDDEN قبل
    // التركيب، والقارئُ المشترك يرفض حمولتَها). تبقى دفاعاً في العمق: خطأٌ صريح لا حقلٌ فارغ.
    return {
      status: "error",
      branchId: null,
      branchName: null,
      canOverride: false,
      branches,
      sourceLabel: "لا فرع مسند",
      message: NO_BRANCH_MESSAGE,
      retry,
    };
  }, [session]);
}

function emptyInference(
  status: Extract<SessionBranchInferenceStatus, "loading" | "error">,
  message: string | null,
  retry: () => void,
): SessionBranchInference {
  return {
    status,
    branchId: null,
    branchName: null,
    canOverride: false,
    branches: [],
    sourceLabel: status === "loading" ? "" : "لا فرع نشط",
    message,
    retry,
  };
}
