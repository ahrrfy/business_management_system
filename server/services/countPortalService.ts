// بوابة العدّ الخارجية (Stocktake Count Portal) — خدمة الهوية والعدّ والتسليم — نقطة الدخول العامة.
//
// عقد الشريحة §٥ (docs/stocktake-contract.md): الهوية عبر أحد طريقين:
//   ١) كوكي `count_token`: JWT (jose HS256 بسرّ JWT_SECRET) بحمولة { k:"stk", sid, aid }
//      وصلاحية 12 ساعة — يُصدَر بعد التحقق من PIN التكليف (يُخزَّن hash فقط، scrypt).
//   ٢) مستخدم النظام المسجَّل (ctx.user) المرتبط بتكليف method=USER في الجلسة.
//
// 🔒 قاعدة الجرد الأعمى (لا تساهل): getPortalState لا يُسرّب أبداً expectedQty ولا
// أسعاراً/تكاليف ولا كميات/أسماء عدّات الزملاء — فقط (اسم الصنف/المتغيّر/sku/الوحدات
// وباركوداتها/حالة «معدود» منزوعة الكمية). التوكن يبطل عملياً بانتهاء الجلسة لأن
// submit/finish يتحقّقان من status=COUNTING وتكليف ACTIVE داخل المعاملة.
//
// أُعيد تنظيم المنطق (كان ٨٥١ سطراً في ملف واحد) إلى وحدات متماسكة تحت server/services/countPortal/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي تبقى
// كل المستدعيات (countPortalRouter.ts والاختبار) بلا أي تعديل.
//
// خريطة الوحدات:
//   shared    — رسائل موحّدة مشتركة (غير مُصدَّرة).
//   token     — إصدار/تحقّق توكن الكوكي (jose HS256).
//   identity  — مصادقة PIN/USER + حلّ الهوية.
//   state     — حالة البوابة (جرد أعمى).
//   submit    — تسجيل عدّة.
//   finish    — تسليم التكليف.

export { COUNT_COOKIE_NAME, COUNT_TOKEN_TTL_MS, signCountToken, verifyCountToken } from "./countPortal/token";
export type { CountTokenPayload } from "./countPortal/token";
export { authenticatePin, resolvePortalIdentity } from "./countPortal/identity";
export type { PortalIdentity, PortalAuthResult } from "./countPortal/identity";
export { getPortalState } from "./countPortal/state";
export type { PortalUnit, PortalItem } from "./countPortal/state";
export { submitCount } from "./countPortal/submit";
export type { SubmitCountInput, SubmitCountResult } from "./countPortal/submit";
export { finishAssignment } from "./countPortal/finish";
export type { FinishAssignmentResult } from "./countPortal/finish";
