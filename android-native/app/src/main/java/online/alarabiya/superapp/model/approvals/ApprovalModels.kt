package online.alarabiya.superapp.model.approvals

import online.alarabiya.superapp.model.AppBootstrap

enum class ApprovalKind(
    val apiValue: String,
    val moduleKey: String,
    val title: String,
) {
    INVENTORY("inventory", "inventory", "المخزون"),
    LEAVE("leave", "hr", "الإجازات"),
    VOUCHER("voucher", "treasury", "السندات"),
    GIFT("gift", "gifts", "الهدايا"),

    /**
     * طلبات التحكّم بالبيع (مرتجع/إلغاء/إعادة إصدار/استبدال/استحقاق) — تدقيق ١/٩/٢٦.
     * كان صندوق الموافقات أعمى عنها فتتراكم صامتةً بينما سلّم الموظّف البضاعة والنقد.
     */
    SALES_CONTROL("salesControl", "sales", "عمليات البيع");

    companion object {
        fun fromApi(value: String): ApprovalKind? = entries.firstOrNull { it.apiValue == value }
    }
}

enum class RejectionReasonPolicy {
    REQUIRED,
    NOT_SUPPORTED,
}

data class ApprovalCapabilities(
    val canApprove: Boolean,
    val canReject: Boolean,
    val rejectionReasonPolicy: RejectionReasonPolicy,
    /** The current domain mutations do not accept an idempotency key. */
    val hasServerIdempotencyKey: Boolean = false,
)

data class ApprovalRequest(
    val id: Long,
    val kind: ApprovalKind,
    val title: String,
    val reference: String,
    val detail: String,
    val createdAt: String,
    val amount: String? = null,
    val currentQuantity: Double? = null,
    val targetQuantity: Double? = null,
    /**
     * حقائقُ حمولة الطلب كما يشتقّها الخادم من مصدرٍ مشترك مع شاشة الويب
     * (`shared/salesControlFacts.ts`). للمرتجع: البنود والكمّية ومصير البضاعة ومبلغ الردّ
     * وطريقته. بلا هذه كان المُعتمِدُ على الجوّال ينفّذ حركةَ نقدٍ ومخزونٍ ودفترٍ بلا رؤية
     * رقمٍ ماليٍّ واحد — «مراجعٌ لا يرى ما يراجعه ليس مراجعاً».
     */
    val facts: List<ApprovalFact> = emptyList(),
    val capabilities: ApprovalCapabilities,
) {
    val key: ApprovalKey get() = ApprovalKey(kind, id)
}

/** سطرُ حقيقةٍ معروضٌ للمراجع قبل القرار — عنوانٌ وقيمةٌ نصّيّة جاهزة. */
data class ApprovalFact(val label: String, val value: String)

data class ApprovalKey(val kind: ApprovalKind, val id: Long)

/**
 * مرجع استرداد البطاقة لطلب إلغاء بيعٍ ببطاقة — قرار المُعتمِد لحظة الاعتماد لا لحظة الطلب،
 * نظير حقل الويب (`client/src/pages/SalesControlApprovals.tsx`، `cashRouting.reference`
 * — مراجعة Codex على PR #988، مُعمَّمة لإلغاء البيع في PR #997). ثلاث حالاتٍ لا حالتان:
 * - [Untouched]: المُعتمِد لم يلمس الحقل — يبقى مرجع الطلب كما أرسله الطالب (قد يكون فارغاً
 *   إن لم ينفّذ الاسترداد بعد؛ المرجع صار اختيارياً عند الطلب منذ PR #997).
 * - [Cleared]: لمسه ثمّ تركه/جعله فارغاً عمداً — يُفرَض غيابه فعلياً فيرفض الاعتماد فوراً بلا
 *   أثرٍ إن كانت الطريقة بطاقة (`cancelSaleInTx` تُلزم المرجع لـCARD)، لا رجوعٌ صامتٌ لمرجع
 *   الطالب. يُستعمَل حين لا يطابق المرجع المعروض قسيمة الجهاز فعلياً.
 * - [Value]: نصٌّ جديد يستبدل مرجع الطلب.
 *
 * الفرقُ بين [Untouched] و[Cleared] جوهريٌّ خادمياً (`applyCancelCashRouting`،
 * `server/services/sale/controlRequests.ts`: `undefined` يُبقي الحمولة، `null` صراحةً يُفرَض)
 * فلا يُطوَيان معاً في حالةٍ واحدة.
 */
sealed interface CardReferenceInput {
    data object Untouched : CardReferenceInput
    data object Cleared : CardReferenceInput
    data class Value(val text: String) : CardReferenceInput
}

/** يشتقّ [CardReferenceInput] من حالة حقل إدخالٍ بسيط — لمسٌ + نصّ. */
fun resolveCardReferenceInput(touched: Boolean, text: String): CardReferenceInput = when {
    !touched -> CardReferenceInput.Untouched
    text.isBlank() -> CardReferenceInput.Cleared
    else -> CardReferenceInput.Value(text.trim())
}

sealed interface ApprovalDecision {
    data class Approve(val cardReference: CardReferenceInput = CardReferenceInput.Untouched) : ApprovalDecision
    data class Reject(val reason: String? = null) : ApprovalDecision
}

private const val SALES_CANCEL_REFUND_METHOD_LABEL = "جهة الاسترداد"
private const val SALES_CANCEL_REFUND_METHOD_CARD = "CARD"
private const val SALES_CANCEL_REFERENCE_LABEL = "مرجع جهاز الدفع"

/**
 * هل يحتاج اعتمادُ هذا الطلب مرجعَ جهاز دفعٍ؟ إلغاءُ بيعٍ ببطاقة وحده. لا حقل خامّ
 * `refundPaymentMethod` يصل الجوّال — العقد الحاليّ (`approvalDetail` في
 * `server/routers/superAppRouter.ts`) يرسل حقائقَ عرضٍ مشتقّةً من `shared/salesControlFacts.ts`
 * فقط (المصدر الوحيد المشترك مع شاشة الويب)، فالتحقّق هنا على **قيمة** حقيقة «جهة الاسترداد»
 * (رمز الطريقة الخام كما يخزّنه العمود) لا على تسميةٍ مترجمة. ملاحظة: `facts` لا تُملأ إلا بعد
 * `approvalDetail` (الاختيار) — قبلها هذا يُقيَّم `false` دائماً، كما هو الحال لبقيّة الحقائق.
 */
val ApprovalRequest.needsCardCancelReference: Boolean
    get() = kind == ApprovalKind.SALES_CONTROL && facts.any {
        it.label == SALES_CANCEL_REFUND_METHOD_LABEL && it.value == SALES_CANCEL_REFUND_METHOD_CARD
    }

/**
 * حقيقةُ مرجع الجهاز المعروضة، إن وُجدت — نصٌّ جاهزٌ للعرض فقط (قد يكون القيمة الحقيقية أو
 * نائب «لم يُدخَل بعد»)، ⛔ **لا يُستعمَل لتعبئة حقل الإدخال مسبقاً**: النائب نصٌّ عربيٌّ حرفيّ
 * لا قيمةً حقيقية، وتعبئته في حقلٍ قابلٍ للتعديل تخاطر بإرساله كأنه مرجعٌ فعليّ.
 */
val ApprovalRequest.cardCancelReferenceFact: ApprovalFact?
    get() = facts.firstOrNull { it.label == SALES_CANCEL_REFERENCE_LABEL }

data class ApprovalDecisionReceipt(
    val requestId: Long,
    val kind: ApprovalKind,
    val decision: ApprovalDecision,
)

/**
 * Client-side visibility is defense in depth. The server remains authoritative and repeats
 * module access, branch scope, role, and maker-checker checks for both inbox and mutations.
 */
data class ApprovalAccessPolicy(private val writableKinds: Set<ApprovalKind>) {
    fun canManage(kind: ApprovalKind): Boolean = kind in writableKinds

    fun filter(requests: List<ApprovalRequest>): List<ApprovalRequest> =
        requests.filter { canManage(it.kind) }

    companion object {
        fun fromBootstrap(
            bootstrap: AppBootstrap,
            effectiveBranchId: Long? = bootstrap.branchId,
        ): ApprovalAccessPolicy {
            val fullModules = bootstrap.modules
                .filter { it.access.equals("FULL", ignoreCase = true) }
                .mapTo(mutableSetOf()) { it.key }
            val role = bootstrap.user.role.lowercase()
            val manager = role == "admin" || role == "manager"
            val treasuryApprover = manager || role == "accountant"

            return ApprovalAccessPolicy(buildSet {
                if (manager && "inventory" in fullModules) add(ApprovalKind.INVENTORY)
                if ("hr" in fullModules) add(ApprovalKind.LEAVE)
                // vouchers.approve/reject explicitly reject sessions without an assigned branch,
                // including an otherwise global admin session.
                if (treasuryApprover && effectiveBranchId != null && "treasury" in fullModules) {
                    add(ApprovalKind.VOUCHER)
                }
                if (manager && "gifts" in fullModules) add(ApprovalKind.GIFT)
            })
        }

        fun allow(kinds: Set<ApprovalKind>): ApprovalAccessPolicy = ApprovalAccessPolicy(kinds)
    }
}
