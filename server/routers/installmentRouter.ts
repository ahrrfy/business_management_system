// بند 12أ (٧/٧): راوتر الأقساط والشيكات الآجلة — هيكل مبدئي يملؤه عامل شريحة installments
// (قائمة الخطط/إنشاء/سداد قسط بسند قبض/ارتجاع شيك/إلغاء + طابور الاستحقاق).
import { router, managerProcedure } from "../trpc";

export const installmentRouter = router({
  /** عنصر نائب — يُستبدل بإجراءات الشريحة الكاملة. */
  list: managerProcedure.query(async () => ({ rows: [], total: 0 })),
});
