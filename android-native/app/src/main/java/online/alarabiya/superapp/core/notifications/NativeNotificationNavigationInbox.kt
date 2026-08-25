package online.alarabiya.superapp.core.notifications

import android.content.Intent
import android.net.Uri
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import online.alarabiya.superapp.core.navigation.DeepLinkResult
import online.alarabiya.superapp.core.navigation.NativeDeepLinkCodec
import online.alarabiya.superapp.core.navigation.NativeDestination

data class NativeNotificationNavigation(
    val destination: NativeDestination,
    val kind: String? = null,
)

/**
 * One-shot typed destinations delivered by immutable notification PendingIntents.
 *
 * Codex P1 (٢٥/٨) — يفرض «إثبات المنشأ» على أيّ intent يفتح شاشةً حسّاسة:
 *   1. يجب أن يحمل EXTRA_NOTIFICATION_KIND (تضعه NativeNotificationRenderer عند البناء).
 *      Intent مزوَّرٌ من تطبيقٍ آخر لا يعرف هذا الوسم فيسقط عند [require].
 *   2. أيضاً يجب أن يكون الـreferrer من packageName نفسه (verifyOwnPackage). Android يضع
 *      referrer=«android-app://<package>» تلقائياً لكل startActivity — تطبيقٌ آخر لا يستطيع
 *      تزويره لأنّه يعكس معرّف المرسِل الحقيقيّ في نواة النظام.
 *   3. حذف intent-filter لـalrueya:// من المانيفست يُلغي المسار الضمنيّ بالكامل، فما تبقى
 *      هو استدعاءٌ صريح ينكشف بحرسَي (١) و(٢).
 */
object NativeNotificationNavigationInbox {
    private val channel = Channel<NativeNotificationNavigation>(capacity = Channel.BUFFERED)
    val destinations: Flow<NativeNotificationNavigation> = channel.receiveAsFlow()

    /**
     * @param intent الطلب الوارد من MainActivity.onCreate / onNewIntent.
     * @param callerReferrer قيمة `Activity.referrer` (URI بصيغة `android-app://<package>`).
     *                       `null` = onNewIntent بلا referrer معلن ⇒ نُقبل بشرط المفتاح الأولى.
     * @param ownPackageName اسم الحزمة المتوقّع (BuildConfig.APPLICATION_ID) للفحص.
     */
    fun accept(
        intent: Intent?,
        callerReferrer: Uri? = null,
        ownPackageName: String? = null,
    ): Boolean {
        if (intent?.action != Intent.ACTION_VIEW) return false
        val raw = intent.dataString ?: return false
        val parsed = NativeDeepLinkCodec.parse(raw)
        if (parsed !is DeepLinkResult.Accepted) return false

        // (١) الوسمُ الداخليّ إلزاميّ — يوثّق أنّ الـintent صُنع بواسطة NativeNotificationRenderer.
        val kind = intent.getStringExtra(NativeNotificationRenderer.EXTRA_NOTIFICATION_KIND)
            ?: return false

        if (!NativeNotificationPayloadParser.allowsDestination(kind, parsed.destination)) return false

        // (٢) عندما يُمرَّر referrer، يجب أن يشير إلى الحزمة نفسها. غيابُهما معاً استثناءٌ للتوافق
        // الخلفيّ في حالاتٍ نادرة يُطلق فيها النظامُ الـActivity بلا referrer (مثل استعادة onSaveInstanceState)،
        // وحينذاك يبقى الوسمُ الداخليّ خطَّ الدفاع الأخير.
        if (callerReferrer != null && ownPackageName != null) {
            val referrerHost = callerReferrer.host
            val scheme = callerReferrer.scheme
            if (scheme != "android-app" || referrerHost != ownPackageName) return false
        }

        return channel.trySend(NativeNotificationNavigation(parsed.destination, kind)).isSuccess
    }
}
