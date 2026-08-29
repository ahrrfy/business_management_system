package online.alarabiya.superapp.ui

import android.content.res.Configuration
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * ArabicDatePicker (Wave 3، ٢٩/٨) — حقل تاريخٍ موحَّد لكلّ الشاشات.
 *
 * سياق القرار:
 *  - Codex P2 (٢٨/٨، #857) رصد أنّ لوحة KeyboardType.Number لا توفّر مفتاح «-» بينما
 *    canSubmit في كثيرٍ من الشاشات يشترط YYYY-MM-DD ⇒ المستخدم يعجز عن إعادة بناء
 *    التاريخ بعد المسح، فيبقى زرّ الحفظ معطَّلاً. الحلّ الجذريّ: منتقي تقويم بدل حقل نصّ.
 *  - قرار المالك (ذاكرة `feedback-latin-digits-always.md`، ٢٥/٨): كلّ رقمٍ يعرضه النظامُ
 *    لاتينيّ. نُنسّق التاريخ بـ ISO (`YYYY-MM-DD`) بأرقامٍ لاتينية دائماً — ونُلبِس التقويم
 *    نفسه Locale `ar-IQ-u-nu-latn` عبر CompositionLocalProvider ⇒ الأرقام داخل شبكة
 *    الأيام والسنوات تخرج لاتينية على أجهزة locale عربيّ (Codex P2 ٢٩/٨).
 *
 * ملاحظة زمنيّة حاسمة (Codex P1 ٢٩/٨):
 *  Material3 `DatePickerState.initialSelectedDateMillis` و`selectedDateMillis` يفسّران
 *  epoch بـ**UTC calendar** لا بمنطقة الجهاز — التقويم ذاتُه بلا وقت. حساب midnight
 *  بمنطقة بغداد كان يُرجع «2026-08-29 Baghdad = 2026-08-28T21:00Z» فيُبرز الحوارُ
 *  اليومَ السابق، وتأكيدُه يحفظ تاريخاً خاطئاً. الحلّ: تحويلٌ `LocalDate ↔ UTC midnight
 *  epoch` مباشرةً، بلا زمنيّة إطلاقاً — التقويم لا يعرض ولا يستقبل ساعة.
 *
 * مسموحٌ التمرير على الشاشات الحاليّة على مراحل: كل استدعاء يُبدل OutlinedTextField
 * بحقلٍ للقراءة + زرّ يفتح Dialog. القيمة تُخزَّن نصّاً YYYY-MM-DD كما تتوقّعها الخدمات.
 *
 * @param value    قيمة `YYYY-MM-DD` أو فارغة.
 * @param onValue  callback يستقبل `YYYY-MM-DD` بعد اختيار المستخدم (أو "" للمسح).
 * @param label    نصّ الحقل (عربيّ افتراضاً — أدخله بلا "YYYY-MM-DD").
 * @param allowClear إن `true` يظهر زرّ «مسح» داخل Dialog.
 * @param enabled  عطّل الحقل + الزرّ بلا إخفائهما.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArabicDatePicker(
  value: String,
  onValue: (String) -> Unit,
  label: String,
  modifier: Modifier = Modifier.fillMaxWidth(),
  allowClear: Boolean = true,
  enabled: Boolean = true,
) {
  var dialogOpen by remember { mutableStateOf(false) }
  val parsedInitial = remember(value) { parseIsoDate(value) }

  OutlinedTextField(
    value = value,
    onValueChange = {},
    modifier = modifier,
    label = { Text(label) },
    singleLine = true,
    readOnly = true,
    enabled = enabled,
    trailingIcon = {
      OutlinedButton(
        onClick = { if (enabled) dialogOpen = true },
        enabled = enabled,
      ) { Text("اختيار") }
    },
  )

  if (dialogOpen) {
    val state = androidx.compose.material3.rememberDatePickerState(
      // UTC midnight — Material3 يعامل هذا الحقل بحسابٍ تقويميّ UTC (لا وقت).
      initialSelectedDateMillis = parsedInitial?.let { localDateToUtcMillis(it) },
    )
    val baseConfig = LocalConfiguration.current
    // Locale ar-IQ-u-nu-latn ⇒ أرقام لاتينيّة داخل التقويم على أجهزة locale عربيّ أيضاً.
    val latinConfig = remember(baseConfig) {
      Configuration(baseConfig).apply { setLocale(LATIN_ARABIC_LOCALE) }
    }
    CompositionLocalProvider(LocalConfiguration provides latinConfig) {
      DatePickerDialog(
        onDismissRequest = { dialogOpen = false },
        confirmButton = {
          Button(onClick = {
            val millis = state.selectedDateMillis
            if (millis != null) {
              val picked = utcMillisToLocalDate(millis)
              onValue(picked.format(ISO_FORMATTER))
            }
            dialogOpen = false
          }) { Text("موافق") }
        },
        dismissButton = {
          if (allowClear && value.isNotBlank()) {
            OutlinedButton(onClick = {
              onValue("")
              dialogOpen = false
            }) { Text("مسح") }
          } else {
            OutlinedButton(onClick = { dialogOpen = false }) { Text("رجوع") }
          }
        },
      ) {
        DatePicker(state = state)
      }
    }
  }
}

/** Locale-neutral ISO formatter — أرقام لاتينية دائماً (قرار المالك ٢٥/٨). */
private val ISO_FORMATTER: DateTimeFormatter =
  DateTimeFormatter.ofPattern("yyyy-MM-dd", Locale.US)

/** ar-IQ with Latin numbering — نُلبسه التقويمَ عبر LocalConfiguration. */
private val LATIN_ARABIC_LOCALE: Locale = Locale.forLanguageTag("ar-IQ-u-nu-latn")

/** LocalDate → UTC midnight epoch millis (عقد Material3 DatePickerState). */
private fun localDateToUtcMillis(date: LocalDate): Long =
  date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()

/** UTC midnight epoch millis → LocalDate (عكس localDateToUtcMillis). */
private fun utcMillisToLocalDate(millis: Long): LocalDate =
  Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()

/**
 * Parse `YYYY-MM-DD`. أي شكلٍ آخر (نص، أرقام هندية، ISO 8601 بوقت) ⇒ `null`
 * فيفتح Dialog بلا تاريخٍ مُنتقى مسبقاً بدل السقوط.
 */
private fun parseIsoDate(raw: String): LocalDate? {
  val trimmed = raw.trim()
  if (trimmed.isEmpty()) return null
  return try {
    LocalDate.parse(trimmed, ISO_FORMATTER)
  } catch (_: Exception) {
    null
  }
}
