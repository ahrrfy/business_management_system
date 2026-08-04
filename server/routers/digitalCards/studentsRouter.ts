// الطلاب (ش٦) — راوتر البطاقات الرقمية والاشتراكات.
// بحثٌ للكاشير بالحدّ الأدنى من البيانات — بلا أرقام مالية للعميل، ولا PII في الأخطاء.
// لا إنشاء ولا تعديل هنا: ملفّ الطالب يُثبَّت داخل معاملة تثبيت البيع (شريحة لاحقة)،
// فلا يبقى في القاعدة طالبٌ لبيعٍ لم يكتمل.
import { z } from "zod";
import { studentService } from "../../services/digitalCards";
import { digitalCardsPosProcedure, router } from "../../trpc";
import { requireDb } from "./shared";

export const studentsRouter = router({
  search: digitalCardsPosProcedure
    .input(
      z.object({
        studentPhone: z.string().max(25).optional(),
        guardianPhone: z.string().max(25).optional(),
        q: z.string().max(80).optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    )
    .query(async ({ input }) => studentService.searchStudents(requireDb(), input)),

  get: digitalCardsPosProcedure
    .input(z.object({ customerId: z.number().int().positive() }))
    .query(async ({ input }) => studentService.getStudent(requireDb(), input.customerId)),

  /** تلميح «لهذا الوليّ N أبناء» — يذكّر الكاشير بألّا يدمج الإخوة في ملفٍّ واحد. */
  siblingCount: digitalCardsPosProcedure
    .input(z.object({ guardianPhone: z.string().min(1).max(25) }))
    .query(async ({ input }) => ({
      count: await studentService.countSiblings(requireDb(), input.guardianPhone),
    })),

  /** فحص الهاتف قبل الإضافة للسلة: جديد أم مرتبطٌ بملفّ واحد أم ملتبسٌ يحتاج اختياراً. */
  resolveByPhone: digitalCardsPosProcedure
    .input(z.object({ studentPhone: z.string().min(1).max(25) }))
    .query(async ({ input }) => studentService.resolveStudentByPhone(requireDb(), input.studentPhone)),
});
