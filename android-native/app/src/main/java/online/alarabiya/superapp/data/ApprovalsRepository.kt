package online.alarabiya.superapp.data

import online.alarabiya.superapp.core.network.TrpcClient
import online.alarabiya.superapp.model.approvals.ApprovalCapabilities
import online.alarabiya.superapp.model.approvals.ApprovalDecision
import online.alarabiya.superapp.model.approvals.ApprovalDecisionReceipt
import online.alarabiya.superapp.model.approvals.ApprovalFact
import online.alarabiya.superapp.model.approvals.ApprovalKind
import online.alarabiya.superapp.model.approvals.ApprovalRequest
import online.alarabiya.superapp.model.approvals.CardReferenceInput
import online.alarabiya.superapp.model.approvals.RejectionReasonPolicy
import org.json.JSONArray
import org.json.JSONObject

interface ApprovalsDataSource {
    suspend fun loadPending(): List<ApprovalRequest>
    suspend fun loadDetail(request: ApprovalRequest): ApprovalRequest = request
    suspend fun decide(request: ApprovalRequest, decision: ApprovalDecision): ApprovalDecisionReceipt
}

data class ApprovalInboxPayload(
    val kind: String,
    val id: Long,
    val title: String,
    val reference: String,
    val detail: String,
    val createdAt: String,
    val amount: String? = null,
    val currentQuantity: Double? = null,
    val targetQuantity: Double? = null,
    /** حقائقُ الحمولة المشتقّة خادمياً (مصدرٌ مشترك مع شاشة الويب). */
    val facts: List<ApprovalFact> = emptyList(),
    val canReject: Boolean,
)

object ApprovalMapper {
    fun fromPayload(payload: ApprovalInboxPayload): ApprovalRequest? {
        val kind = ApprovalKind.fromApi(payload.kind) ?: return null
        if (payload.id <= 0) return null
        val rejectionPolicy = when (kind) {
            ApprovalKind.INVENTORY, ApprovalKind.VOUCHER, ApprovalKind.SALES_CONTROL ->
                RejectionReasonPolicy.REQUIRED
            ApprovalKind.LEAVE, ApprovalKind.GIFT -> RejectionReasonPolicy.NOT_SUPPORTED
        }
        return ApprovalRequest(
            id = payload.id,
            kind = kind,
            title = payload.title,
            reference = payload.reference,
            detail = payload.detail,
            createdAt = payload.createdAt,
            amount = payload.amount,
            currentQuantity = payload.currentQuantity,
            targetQuantity = payload.targetQuantity,
            facts = payload.facts,
            capabilities = ApprovalCapabilities(
                canApprove = true,
                canReject = payload.canReject,
                rejectionReasonPolicy = rejectionPolicy,
            ),
        )
    }
}

class UnsupportedApprovalDecision(message: String) : IllegalArgumentException(message)

/**
 * Native facade over the existing domain APIs.
 *
 * Known server-contract boundaries (2026-08-06):
 * - `superApp.approvalInbox` is capped at 30 items and has no cursor. Selection is revalidated
 *   through `superApp.approvalDetail` before a decision is offered.
 * - leave rejection supports a decision only; there is no rejection-reason field.
 * - gifts expose approval only; there is no gift rejection mutation.
 * - voucher decisions require a session branch, although the aggregate inbox can return vouchers
 *   to a branchless admin. ApprovalAccessPolicy suppresses those non-actionable rows.
 * - none of the four decision mutations accepts an idempotency key. The UI therefore prevents
 *   concurrent repeat taps, while the domain service remains authoritative for stale requests.
 */
class ApprovalsRepository(private val api: TrpcClient) : ApprovalsDataSource {
    override suspend fun loadPending(): List<ApprovalRequest> =
        // tRPC v11 preserves `null` as a value; the server contract accepts an omitted/empty
        // optional object, not JSON null. Send the explicit empty filter used by this client.
        api.queryArray("superApp.approvalInbox", JSONObject())
            .objects()
            .mapNotNull { ApprovalMapper.fromPayload(it.toApprovalPayload()) }

    override suspend fun loadDetail(request: ApprovalRequest): ApprovalRequest {
        val detail = api.query(
            "superApp.approvalDetail",
            JSONObject().put("kind", request.kind.apiValue).put("id", request.id),
        )
        return ApprovalMapper.fromPayload(detail.toApprovalPayload())
            ?: throw IllegalStateException("تعذّر تحميل تفاصيل الاعتماد")
    }

    override suspend fun decide(
        request: ApprovalRequest,
        decision: ApprovalDecision,
    ): ApprovalDecisionReceipt {
        require(request.id > 0) { "معرّف الطلب غير صالح" }
        when (decision) {
            is ApprovalDecision.Approve -> {
                if (!request.capabilities.canApprove) {
                    throw UnsupportedApprovalDecision("اعتماد هذا النوع غير متاح في العقد الحالي")
                }
                approve(request, decision.cardReference)
            }
            is ApprovalDecision.Reject -> reject(request, decision.reason)
        }
        return ApprovalDecisionReceipt(request.id, request.kind, decision)
    }

    private suspend fun approve(request: ApprovalRequest, cardReference: CardReferenceInput) {
        when (request.kind) {
            ApprovalKind.INVENTORY -> api.mutate(
                "inventory.approveAdjustment",
                JSONObject().put("id", request.id),
            )
            ApprovalKind.LEAVE -> api.mutate(
                "leaves.decide",
                JSONObject().put("id", request.id).put("decision", "approved"),
            )
            ApprovalKind.VOUCHER -> api.mutate(
                "vouchers.approve",
                JSONObject().put("receiptId", request.id),
            )
            ApprovalKind.GIFT -> api.mutate(
                "gifts.approveGift",
                JSONObject().put("giftId", request.id),
            )
            /**
             * الاعتماد ينفّذ الأثر ذرّياً خادمياً (مرتجع/إلغاء/استبدال) بنفس مسار الويب.
             *
             * `clearShift` = «أعِد اشتقاق مصدر النقد الآن» (تصويب مراجعة Codex على PR #932):
             * الدرجُ المُختار وقت **الطلب** قد يكون أُقفل، وبلا هذا يفشل الاعتماد على الجوّال
             * أبداً بينما الويب يستطيع إنقاذه. ولا يختار درجاً بالنيابة عن المُعتمِد: الخادمُ
             * يأخذ الدرجَ المفتوح الوحيد، ويطلب تحديداً صريحاً إن تعدّد، ويصرف من خزينة الفرع
             * للإداريّ إن لم يوجد — أيْ نفس افتراض المسار الأونلاينيّ حين لا يُحدَّد درج.
             *
             * `reference` (تعميم PR #997 لإلغاء البيع ببطاقة): مرجع جهاز الدفع قرارُ لحظة
             * الاعتماد لا لحظة الطلب — بلا هذا يضطرّ الطالبُ لتنفيذ الاسترداد الفعليّ على
             * الجهاز قبل أن يبتّ أيّ مراجعٍ في الطلب أصلاً. [buildSalesControlApproveInput]
             * يترجم [CardReferenceInput] الثلاثيّ إلى شكل الحمولة (مفتاحٌ غائب/`null`/قيمة).
             */
            ApprovalKind.SALES_CONTROL -> api.mutate(
                "salesControl.approve",
                buildSalesControlApproveInput(request.id, cardReference),
            )
        }
    }

    private suspend fun reject(request: ApprovalRequest, rawReason: String?) {
        if (!request.capabilities.canReject) {
            throw UnsupportedApprovalDecision("رفض هذا النوع غير متاح في العقد الحالي")
        }
        val reason = rawReason?.trim().orEmpty()
        require(reason.length <= 500) { "سبب الرفض يجب ألا يتجاوز 500 حرف" }
        when (request.kind) {
            ApprovalKind.INVENTORY -> {
                require(reason.isNotEmpty()) { "سبب الرفض مطلوب" }
                api.mutate(
                    "inventory.rejectAdjustment",
                    JSONObject().put("id", request.id).put("reason", reason),
                )
            }
            ApprovalKind.VOUCHER -> {
                require(reason.isNotEmpty()) { "سبب الرفض مطلوب" }
                api.mutate(
                    "vouchers.reject",
                    JSONObject().put("receiptId", request.id).put("reason", reason),
                )
            }
            ApprovalKind.LEAVE -> api.mutate(
                "leaves.decide",
                JSONObject().put("id", request.id).put("decision", "rejected"),
            )
            ApprovalKind.GIFT -> throw UnsupportedApprovalDecision(
                "واجهة الخادم لا توفر عملية رفض للهدايا",
            )
            ApprovalKind.SALES_CONTROL -> {
                require(reason.isNotEmpty()) { "سبب الرفض مطلوب" }
                api.mutate(
                    "salesControl.reject",
                    JSONObject().put("requestId", request.id).put("reason", reason),
                )
            }
        }
    }
}

private fun JSONArray.objects(): List<JSONObject> = buildList {
    for (index in 0 until length()) optJSONObject(index)?.let(::add)
}

/**
 * يبني حمولة `salesControl.approve`. `reference` حسب حالة [CardReferenceInput] الثلاث
 * (تفصيلها في تعريف النوع): [CardReferenceInput.Untouched] يُغفَل المفتاح كليّاً (بلا مساسٍ
 * بمرجع الطلب المخزَّن)، [CardReferenceInput.Cleared] يرسل `null` صراحةً، و[CardReferenceInput.Value]
 * يرسل النصّ. إغفالُ المفتاح و`null` صريحة مختلفان جوهرياً خادمياً
 * (`applyCancelCashRouting`، `server/services/sale/controlRequests.ts`) فلا يُطوَيان معاً —
 * `org.json.JSONObject` يفرّق بينهما فعلياً: مفتاحٌ لم يُستدعَ له `put` لا يظهر أصلاً في
 * `toString()`، بينما `put(key, JSONObject.NULL)` يظهر بقيمة `null` حرفية.
 */
internal fun buildSalesControlApproveInput(requestId: Long, cardReference: CardReferenceInput): JSONObject {
    val cashRouting = JSONObject().put("clearShift", true)
    when (cardReference) {
        CardReferenceInput.Untouched -> Unit
        CardReferenceInput.Cleared -> cashRouting.put("reference", JSONObject.NULL)
        is CardReferenceInput.Value -> cashRouting.put("reference", cardReference.text)
    }
    return JSONObject().put("requestId", requestId).put("cashRouting", cashRouting)
}

private fun JSONObject.toApprovalPayload() = ApprovalInboxPayload(
    kind = optString("kind"),
    id = optLong("id"),
    title = optString("title"),
    reference = optString("reference"),
    detail = optString("detail"),
    createdAt = optString("createdAt"),
    amount = nullableText("amount"),
    currentQuantity = nullableDouble("currentQuantity"),
    targetQuantity = nullableDouble("targetQuantity"),
    facts = optJSONArray("facts")?.let { array ->
        buildList {
            for (index in 0 until array.length()) {
                val row = array.optJSONObject(index) ?: continue
                val label = row.optString("label")
                val value = row.optString("value")
                if (label.isNotBlank()) add(ApprovalFact(label, value))
            }
        }
    } ?: emptyList(),
    canReject = optBoolean("canReject"),
)

private fun JSONObject.nullableText(key: String): String? =
    if (!has(key) || isNull(key)) null else opt(key)?.toString()?.takeIf(String::isNotBlank)

private fun JSONObject.nullableDouble(key: String): Double? =
    if (!has(key) || isNull(key)) null else optDouble(key).takeUnless(Double::isNaN)
