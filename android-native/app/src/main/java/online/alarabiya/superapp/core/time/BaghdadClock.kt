package online.alarabiya.superapp.core.time

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * BaghdadClock (Wave 3، ٢٩/٨) — يوم الأعمال بتوقيت العراق.
 *
 * سياق القرار (منسجم مع server/services/businessDay.ts + الذاكرة businessday-framework):
 *  - Asia/Baghdad = UTC+3 بلا DST. البيع/الشراء والقيود المحاسبيّة والتقارير كلّها تُنسَب
 *    لـ«يوم الأعمال في بغداد»، لا ليوم توقيت الجهاز. جهازٌ يسافر خارج العراق قد يعتبر
 *    اليومَ التاليَ بينما الفرع في بغداد لا يزال في اليوم السابق، ⇒ فاتورةُ منتصف الليل
 *    تُختَم بيوم لا يوجد فيه شفت مفتوح فتُرفض من الخادم.
 *  - ذاكرة `feedback-latin-digits-always`: كل رقمٍ يعرضه النظامُ لاتينيّ ⇒ ISO 8601
 *    الخالص هنا بلا `Locale` (yyyy-MM-dd) يضمن ذلك على جميع الأجهزة.
 *
 * الاستعمال:
 *   ✔ حقل «تاريخ الشراء الافتراضي = اليوم» في شاشة الاقتناء → `baghdadToday().toString()`
 *   ✔ تصنيف يوم الأعمال في ViewModel قبل إرسال الطلب → `baghdadToday()`
 *   ✘ **لا تستعمل** `Instant.now()` هنا — Instant لا زمنيّة له أصلاً (UTC epoch).
 *
 * الحرس: لا تُعِد استخدام `LocalDate.now()` بدون zone في `feature/` أو `model/` الجديد —
 * أدخِله عبر `baghdadToday()` أو مرِّر `now: () -> LocalDate` قابلاً للحقن للاختبار.
 */
val BAGHDAD_ZONE: ZoneId = ZoneId.of("Asia/Baghdad")

fun baghdadToday(): LocalDate = LocalDate.now(BAGHDAD_ZONE)

fun baghdadNow(): ZonedDateTime = ZonedDateTime.now(BAGHDAD_ZONE)

fun baghdadLocalDateTime(): LocalDateTime = LocalDateTime.now(BAGHDAD_ZONE)
