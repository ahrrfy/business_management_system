import { z } from "zod";

/**
 * مخطط ونوع موحّد لاعتماد المدير:
 * 1. مسح باركود شارة المدير (barcode).
 * 2. إدخال اسم المستخدم / البريد مع رمز PIN المخصص (pin).
 * 3. خيار البريد وكلمة المرور الكلاسيكي (email + password).
 */
export const managerApprovalSchema = z.union([
  z.object({
    method: z.literal("PIN"),
    pin: z.string().min(1, "رمز PIN مطلوب"),
    identifier: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
  }).passthrough().refine((d) => !!(d.identifier?.trim() || d.username?.trim() || d.email?.trim()), {
    message: "يجب إدخال اسم المستخدم أو البريد مع رمز PIN",
  }),
  z.object({
    method: z.literal("PASSWORD"),
    email: z.string().min(1, "البريد الإلكتروني مطلوب"),
    password: z.string().min(1, "كلمة المرور مطلوبة"),
  }).passthrough(),
  z.object({
    method: z.literal("BARCODE"),
    barcode: z.string().min(1, "رمز الباركود مطلوب"),
  }).passthrough(),
  z.object({
    method: z.enum(["BARCODE", "PIN", "PASSWORD"]).optional(),
    barcode: z.string().min(1, "رمز الباركود مطلوب"),
  }).passthrough(),
  z.object({
    method: z.enum(["BARCODE", "PIN", "PASSWORD"]).optional(),
    pin: z.string().min(1, "رمز PIN مطلوب"),
    identifier: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
  }).passthrough().refine((d) => !!(d.identifier?.trim() || d.username?.trim() || d.email?.trim()), {
    message: "يجب إدخال اسم المستخدم أو البريد مع رمز PIN",
  }),
  z.object({
    method: z.enum(["BARCODE", "PIN", "PASSWORD"]).optional(),
    email: z.string().min(1, "البريد الإلكتروني مطلوب"),
    password: z.string().min(1, "كلمة المرور مطلوبة"),
  }).passthrough(),
  z.object({
    method: z.enum(["BARCODE", "PIN", "PASSWORD"]).optional(),
    barcode: z.string().min(1).optional(),
    pin: z.string().min(1).optional(),
    identifier: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
  }).passthrough().refine(
    (d) =>
      !!(
        d.barcode?.trim() ||
        (d.pin?.trim() && (d.identifier?.trim() || d.username?.trim() || d.email?.trim())) ||
        (d.email?.trim() && d.password)
      ),
    { message: "بيانات اعتماد المدير غير مكتملة" }
  ),
]);

export type ManagerApprovalInput = z.infer<typeof managerApprovalSchema>;
