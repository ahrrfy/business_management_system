/**
 * محافظات العراق + أجرة توصيل تقديرية (د.ع) — المصدر **الوحيد** المشترك:
 *  • العميل: عرض قائمة المحافظات وتقدير الأجرة عند الطلب (client/src/pages/Storefront).
 *  • الخادم: حساب الأجرة **المُلزِم** المخزَّن على الطلب (server/services/onlineOrderService).
 *
 * الأجرة هنا **تقديرية للعرض**؛ الأجرة الفعلية يثبّتها الموظف عند الإسناد للتوصيل (شريحة ٤).
 * ١٨ محافظة — عدّلها بحرّية (المالك).
 */
export interface Governorate {
  id: string;
  name: string;
  /** أجرة توصيل تقديرية بالدينار العراقي (عدد صحيح). */
  deliveryFee: number;
}

export const GOVERNORATES: Governorate[] = [
  { id: "baghdad", name: "بغداد", deliveryFee: 5000 },
  { id: "basra", name: "البصرة", deliveryFee: 8000 },
  { id: "nineveh", name: "نينوى (الموصل)", deliveryFee: 8000 },
  { id: "erbil", name: "أربيل", deliveryFee: 8000 },
  { id: "sulaymaniyah", name: "السليمانية", deliveryFee: 8000 },
  { id: "duhok", name: "دهوك", deliveryFee: 8000 },
  { id: "kirkuk", name: "كركوك", deliveryFee: 8000 },
  { id: "diyala", name: "ديالى (بعقوبة)", deliveryFee: 7000 },
  { id: "anbar", name: "الأنبار (الرمادي)", deliveryFee: 8000 },
  { id: "babil", name: "بابل (الحلة)", deliveryFee: 6000 },
  { id: "karbala", name: "كربلاء", deliveryFee: 7000 },
  { id: "najaf", name: "النجف", deliveryFee: 7000 },
  { id: "qadisiyah", name: "القادسية (الديوانية)", deliveryFee: 7000 },
  { id: "muthanna", name: "المثنى (السماوة)", deliveryFee: 8000 },
  { id: "dhiqar", name: "ذي قار (الناصرية)", deliveryFee: 8000 },
  { id: "maysan", name: "ميسان (العمارة)", deliveryFee: 8000 },
  { id: "wasit", name: "واسط (الكوت)", deliveryFee: 7000 },
  { id: "saladin", name: "صلاح الدين (تكريت)", deliveryFee: 7000 },
];

export const GOVERNORATE_IDS = GOVERNORATES.map((g) => g.id) as [string, ...string[]];

export function governorateById(id: string): Governorate | undefined {
  return GOVERNORATES.find((g) => g.id === id);
}

/** أجرة التوصيل التقديرية لمحافظة (٠ إن لم تُعرَف — لا رمي). */
export function deliveryFeeFor(id: string): number {
  return governorateById(id)?.deliveryFee ?? 0;
}
