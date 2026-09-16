// ESLint — **ضيّقٌ بقصد**: قواعدُ تمسك أعطاباً حقيقية، لا قواعدُ أسلوب.
//
// لماذا وُجد (٢/٩/٢٦): لم يكن في المستودع مُدقّقٌ إطلاقاً. فمرّ إلى `main` خطّافُ
// `useMemo` تحت `if (isLoading) return` في `AssetDisposalLog` — يتغيّر عددُ الخطّافات بين
// تصييرَين فتسقط الشاشة عند اكتمال التحميل. أمسكه مراجعٌ خارجيّ بعد الدمج، بينما
// `react-hooks/rules-of-hooks` كان يمسكه في ثانية.
//
// ⛔ **لا نضيف قواعد أسلوب**: المستودع ٢٥٩٦ ملفاً بلا مُدقّقٍ سابق، وأيّ قاعدةٍ تجميلية
// تُنتج آلافَ الملاحظات فتُتجاوَز الحزمةُ كلّها (`--no-verify`) ويصير المُدقّق مسرحياً —
// نفسُ الدرس الذي أعاد معايرة `pre-commit` في §٣ من CLAUDE.md. التنسيق شأنُ prettier،
// والأنواع شأنُ tsc. هنا **الأعطاب المنطقية وحدها**.
//
// التوسيع لاحقاً: أضِف قاعدةً **بعد** التأكّد أنّ المستودع نظيفٌ منها (أو مع خطّ أساسٍ
// تنازليّ على نمط حرّاس §٣.١)، لا قبله.

import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    /*
     * ⚠️ **تجاهلٌ عامّ** — كتلةٌ مستقلّة بـ`ignores` وحدها. الـ`ignores` داخل كتلةٍ لها
     * `files` تستثني من **تلك الكتلة** فقط، لا من الفحص كلّه؛ فكان ESLint يمشي على
     * `dist/` و`client/public/` المبنيَّين ويشكو من تعليقاتٍ فيهما.
     */
    ignores: [
      "dist/**",
      ".runtime/**",
      "_legacy/**",
      "android-native/**",
      "client/public/**",
      // سكربتات الورشة تُنفَّذ في سياقٍ يسمح بـ على المستوى الأعلى.
      ".claude/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/__tests__/**",
    ],
  },
  {
    // نطاقُ الفحص: شيفرةُ الواجهة والخادم والمشترك.
    files: ["client/src/**/*.{ts,tsx}", "server/**/*.ts", "shared/**/*.ts"],
    /*
     * `@typescript-eslint` مُسجَّلٌ **بلا تفعيل أيّ قاعدةٍ منه**. السبب: في المستودع
     * تعليقاتُ `eslint-disable-next-line @typescript-eslint/...` كُتبت لمُدقّقٍ لم يوجد
     * قطّ؛ وبلا تسجيل المُلحَق يرفض ESLint كلَّ تعليقٍ منها بـ«Definition for rule was
     * not found» فيتحوّل ١٢٤ تعليقاً إلى ١٢٤ خطأً وهمياً. التسجيلُ يجعل الأسماء تُحَلّ،
     * والقواعدُ تبقى مطفأة فلا ضجيج.
     */
    plugins: { "react-hooks": reactHooks, "@typescript-eslint": tseslint.plugin },
    linterOptions: {
      /*
       * تلك التعليقات نفسها «غير مستعمَلة» بحكم أنّ قواعدها مطفأة — والإبلاغُ عنها
       * ٨٤ مرّة يُغرق الإشارة. تُنظَّف حين تُفعَّل قواعدُها، لا قبل.
       */
      reportUnusedDisableDirectives: "off",
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      /**
       * ⭐ القاعدة التي وُجد المُدقّق لأجلها.
       *
       * خطّافٌ بعد `return` مشروط ⇒ يُنفَّذ في تصييرٍ ولا يُنفَّذ في آخر ⇒ React يسقط
       * («Rendered more hooks than during the previous render») بدل عرض الشاشة.
       * لا يمسكه `tsc` ولا أيّ حارسٍ نصّيّ: كلا الشكلَين صحيحُ الأنواع.
       */
      "react-hooks/rules-of-hooks": "error",

      /**
       * ⛔ مُطفأة عمداً — ليست عطباً بل رأيٌ في الاعتماديات، وتُنتج مئاتِ الملاحظات على
       * شيفرةٍ قائمة تعمل. تشغيلُها اليوم يُغرق الإشارةَ الحقيقية أعلاه.
       * تُفعَّل حين يُخصَّص لها تنظيفٌ مستقلّ بخطّ أساسٍ تنازليّ.
       */
      "react-hooks/exhaustive-deps": "off",
    },
  },
);
