import { z } from "zod";

/** Nonnegative money with at most two decimal places; shared API input contract. */
export const nonNegMoneyString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "مبلغ غير صالح (غير سالب، منزلتان كحدّ أقصى)");
