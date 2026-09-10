// أنواع مشتركة عامة لحزمة الجرد.

/** الفاعل: role وisOwner اختياريان — تحتاجهما حوكمة «الجرد الافتتاحي» وSOD (استثناء admin والمالك isOwner للتصحيح الإداري والسيادي). */
export type StkActor = { userId: number; role?: string; isOwner?: boolean };
