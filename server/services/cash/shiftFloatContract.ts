/**
 * أول يومٍ كامل بعد إدخال عقد عهدة الافتتاح SF في openShift (#377).
 * ما قبله تاريخي وقد لا يملك قيد SHIFT_FLOAT_OUT؛ وما بعده يفشل مغلقاً إذا غاب الدليل.
 */
export const SHIFT_FLOAT_CONTRACT_CUTOFF = new Date("2026-07-29T00:00:00.000Z");
