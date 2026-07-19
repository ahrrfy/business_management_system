// أنواع مشتركة عامة لحزمة الجرد.

/** الفاعل: role اختياري — تحتاجه حوكمة «الجرد الافتتاحي» (إنشاء بمدير فأعلى + استثناء admin في SOD). */
export type StkActor = { userId: number; role?: string };
