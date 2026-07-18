/** حدود فلاتر الفترات (YYYY-MM-DD) — **تفوّض الآن إلى businessDay.ts** (تدقيق ١٧/٧، مخاطرة جهازية #٧).
 *
 *  كانت هذه الدوالّ تبني الحدود بمكوّنات محلية (`new Date(y, m-1, d)`) فتَتبع منطقة عملية Node وتنزاح
 *  على أي جهاز بغير TZ=UTC. صارت تفوّض إلى `businessDay` (بناء بـ`Date.UTC` ⇒ حتميّ ومستقلّ عن المنطقة).
 *  تحت TZ=UTC المفروض (dev/start/test/pm2) السلوك مطابقٌ بايتاً ببايت، فالتفويض بلا أثرٍ سلوكيّ.
 *
 *  الأسماء أُبقيت (localDayStart/localNextDayStart/localTodayDate) توافقاً مع ~١٥ مستهلكاً؛ **الكود
 *  الجديد يستورد من `businessDay` مباشرةً** (utcDayStart/utcNextDayStart/utcTodayStart/utcDayRange/todayUtcDate).
 */
export {
  utcDayStart as localDayStart,
  utcNextDayStart as localNextDayStart,
  utcTodayStart as localTodayDate,
} from "./businessDay";
