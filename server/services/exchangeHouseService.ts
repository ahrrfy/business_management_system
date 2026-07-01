// خدمة «الصيرفة» (الصرّاف / مكتب التحويل) — exchange-house — نقطة الدخول العامة.
// اتفاقية الإشارة على المحفظتين (balanceIqd / balanceUsd): موجب = الصيرفة مدينة لنا (أموالنا لديها).
//   نظير deliveryParties (عهدة) — **معاكسة عمداً** لاتفاقية suppliers. وثّقها هنا حصراً.
// المبادئ المحاسبية (مُثبَتة بالتحقّق العدائي ٧ وكلاء):
//   • الإيداع/السحب نقلُ أصلٍ (receipt على TREASURY + قيد 0/0/0، مُستثنى من الإيراد) — لا مصروف.
//   • شراء الدولار (FX_BUY) تحويلُ أصلٍ داخل الصيرفة (دينار→دولار) يُحدّث متوسط الكلفة WAVG — بلا P&L.
//   • التسديد عبر الصيرفة **لا يمسّ الخزينة** (النقد غادر عند الإيداع): يخفض المحفظة + دين المورد فقط.
//   • فرق الصرف المحقَّق = (الدين الديناري المُطفأ) − (الدولار المدفوع × متوسط كلفته) ⇒ قيد EXCHANGE_FX_DIFF
//     معزول (amount موقَّع، revenue=cost=profit=0) — لا يلوّث إيراد البيع.
//   • العمولة مصروف (EXCHANGE_FEE، cost=amount) تُخصم من المحفظة — لا من دين المورد ولا من تكلفة الشراء.
// الأمان: كل عملية داخل withTx واحدة؛ قفل صفّ الصيرفة .for("update") قبل أي خصم (يمنع TOCTOU/سباق)؛
//   idempotency (clientRequestId) يُسجَّل قبل أي adjust؛ منع المكشوف بتحذير لين قابل للتجاوز (confirmNegative).
//
// أُعيد تنظيم المنطق (كان ٩٠٠ سطر في ملف واحد) إلى وحدات متماسكة تحت server/services/exchange/*
// **بلا أي تغيير سلوكي**: نفس الدوال والتواقيع. هذا الملف يعيد تصدير الواجهة العامة فقط كي يبقى
// exchangeRouter.ts بلا أي تعديل.
//
// خريطة الوحدات:
//   helpers          — تسلسل سعر الصرف + قفل صفّ الصيرفة + ترقيم العمليات — داخلية.
//   crud             — إنشاء/تعديل/تفعيل-تعطيل/قراءة/قائمة الصيرفات + الرصيد الافتتاحي.
//   deposit          — إيداع دينار (نقد فعلي) أو دولار مباشر (معزولتان).
//   withdraw         — سحب دينار أو دولار مباشر (معزولتان).
//   buyUsd           — شراء دولار داخل المحفظة (WAVG).
//   settleSupplier   — تسديد ذمّة مورد عبر الصيرفة (فرق صرف + عمولة).
//   statement        — كشف حساب صيرفة.
//   reconcile        — مطابقة أرصدة (قراءة فقط).

export type { CreateExchangeInput, UpdateExchangeInput, ListExchangeInput } from "./exchange/crud";
export { createExchangeHouse, updateExchangeHouse, setExchangeActive, getExchangeHouse, listExchangeHouses } from "./exchange/crud";
export type { DepositInput } from "./exchange/deposit";
export { depositToExchange } from "./exchange/deposit";
export type { WithdrawInput } from "./exchange/withdraw";
export { withdrawFromExchange } from "./exchange/withdraw";
export type { BuyUsdInput } from "./exchange/buyUsd";
export { buyUsdAtExchange } from "./exchange/buyUsd";
export type { SettleSupplierInput } from "./exchange/settleSupplier";
export { settleSupplierViaExchange } from "./exchange/settleSupplier";
export type { StatementInput } from "./exchange/statement";
export { getExchangeStatement } from "./exchange/statement";
export type { ReconcileInput } from "./exchange/reconcile";
export { reconcileExchange } from "./exchange/reconcile";
