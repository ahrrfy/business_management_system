import { isStrongPassword } from "../../shared/const";

const PUBLISHED_PASSWORDS = new Set([
  "",
  "Admin@12345",
  "ضع-كلمة-قوية-هنا",
  "CHANGE_ME_STRONG_PASSWORD",
]);

export function assertSeedPolicy(env: NodeJS.ProcessEnv): { isProd: boolean; password: string } {
  const isProd = env.SEED_MODE === "prod";
  const password = env.ADMIN_PASSWORD ?? "";

  if (!isProd && env.CONFIRM_SAMPLE_DATA_SEED !== "1") {
    throw new Error(
      "البذرة التجريبية تضيف بيانات عيّنة وحسابات: أعد التشغيل مع CONFIRM_SAMPLE_DATA_SEED=1. للإنتاج استخدم pnpm seed:prod."
    );
  }
  if (PUBLISHED_PASSWORDS.has(password) || password.length < 10 || !isStrongPassword(password)) {
    throw new Error(
      isProd
        ? "بذرة الإنتاج تتطلّب ADMIN_PASSWORD قوية وصريحة وليست قيمة منشورة أو افتراضية."
        : "البذرة التجريبية تتطلّب ADMIN_PASSWORD صريحة وقوية؛ لن تُنشئ حسابات بكلمة منشورة أو افتراضية."
    );
  }

  return { isProd, password };
}
