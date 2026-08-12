// عقد تحرير بند مسيّر الرواتب (updateItem) — الحقول القابلة للتعديل يدوياً على بند في حالة draft فقط.
export interface UpdateItemInput {
  overtime?: string | null;
  deductions?: string | null;
  note?: string | null;
}
