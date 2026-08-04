// برميل راوتر البطاقات الرقمية والاشتراكات (S3: Provider/Wallet/Offering CRUD وما بعدها).
//
// أُعيد تنظيم المنطق (كان ٨٦١ سطراً في ملف واحد) إلى راوترٍ فرعيّ لكل شريحة في مجلّد
// digitalCards/ **بلا أي تغيير سلوكي**: نفس مسارات tRPC المتشعّبة (`digitalCards.pricing.*`،
// `digitalCards.wallets.*`، …) التي كان يبنيها هذا الملف بنفس الأسلوب أصلاً.
//
// خريطة الوحدات (كل ملف = الراوتر الفرعي بنفس اسمه سابقاً):
//   shared      — أدوات مشتركة: requireDb/actorOf/scopedBranchOf/Ctx/idInput.
//   providers   — إعداد المزوّدين (ش٣).
//   wallets     — المحافظ + عمليات الرصيد (ش٩).
//   offerings   — العروض (البطاقات/الاشتراكات).
//   pricing     — أسعار بداية اليوم (ش٤) + بلاغ اختلاف السعر (ش٧.٥).
//   pos         — شبكة بطاقات نقطة البيع (ش٥).
//   students     — بحث الطلاب (ش٦).
//   sales       — نيّة البيع والتنفيذ والتثبيت المالي (ش٧-٨).
//   dashboard   — لوحة المؤشرات (ش١١).
//   reversal    — العكس واستثناءات الخسارة (ش١٢).
import { router } from "../trpc";
import { dashboardRouter } from "./digitalCards/dashboardRouter";
import { offeringsRouter } from "./digitalCards/offeringsRouter";
import { posRouter } from "./digitalCards/posRouter";
import { pricingRouter } from "./digitalCards/pricingRouter";
import { providersRouter } from "./digitalCards/providersRouter";
import { reversalRouter } from "./digitalCards/reversalRouter";
import { salesRouter } from "./digitalCards/salesRouter";
import { studentsRouter } from "./digitalCards/studentsRouter";
import { walletsRouter } from "./digitalCards/walletsRouter";

export const digitalCardsRouter = router({
  dashboard: dashboardRouter,
  reversal: reversalRouter,
  providers: providersRouter,
  wallets: walletsRouter,
  offerings: offeringsRouter,
  pricing: pricingRouter,
  pos: posRouter,
  students: studentsRouter,
  sales: salesRouter,
});
