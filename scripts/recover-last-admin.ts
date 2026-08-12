/**
 * مسار طوارئ محلّي لاستعادة آخر أدمن/مالك عند فقدان كل وصول إداري.
 * لا يقبل كلمة المرور كوسيط command-line أو متغيّر بيئة كي لا تظهر في process list/history.
 *
 * تفاعلياً: pnpm admin:recover
 * بلا TTY:  pnpm admin:recover -- --company acme --identifier admin --confirm-break-glass --password-stdin
 * من ملف مؤقت: أضف --password-file <path> (يجب أن يكون 0600 على POSIX واحذفه بعد النجاح).
 * إذا فُقد عامل 2FA أيضاً: أضف --reset-2fa صراحةً لمسح السر ورموز الاسترداد.
 */
import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { closeDb, isMultiTenantModeActive, withTenantDb } from "../server/db";
import { recoverLastAdminAccess } from "../server/services/passwordResetService";
import { runWithCompany } from "../server/tenancy/context";
import { resolveCompanyByCode } from "../server/tenancy/registry";
import { closeControlDb } from "../server/tenancy/controlDb";

const CONFIRM_PHRASE = "RECOVER LAST ADMIN";
const args = process.argv.slice(2);

function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(flag: string): boolean {
  return args.includes(flag);
}

function fail(message: string): never {
  throw new Error(message);
}

function stripOneLineEnding(value: string): string {
  const result = value.replace(/\r?\n$/, "");
  if (/[\r\n]/.test(result))
    fail("مصدر كلمة المرور يجب أن يحتوي سطراً واحداً فقط.");
  return result;
}

async function readAllStdin(): Promise<string> {
  let value = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) value += chunk;
  return stripOneLineEnding(value);
}

async function readPasswordFile(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) fail("مسار كلمة المرور ليس ملفاً عادياً.");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    fail(
      "ملف كلمة المرور مكشوف لمستخدمين آخرين؛ اضبط صلاحيته إلى 0600 ثم أعد المحاولة.",
    );
  }
  return stripOneLineEnding(await readFile(path, "utf8"));
}

async function hiddenQuestion(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    fail("لا يوجد TTY آمن؛ استعمل --password-stdin أو --password-file.");
  }
  stdout.write(prompt);
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onKeypress = (
      text: string,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if (key.ctrl && key.name === "c")
        return finish(new Error("أُلغي مسار الاستعادة."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        return;
      }
      if (!key.ctrl && text) value += text;
    };
    stdin.on("keypress", onKeypress);
  });
}

async function main() {
  if (valueOf("--password") || args.includes("--password")) {
    fail(
      "يُرفض تمرير كلمة المرور في command-line؛ استعمل الإدخال المخفي أو stdin/ملفاً مؤقتاً.",
    );
  }
  const unknown = args.filter(
    (arg, index) =>
      arg.startsWith("--") &&
      ![
        "--company",
        "--identifier",
        "--password-file",
        "--password-stdin",
        "--confirm-break-glass",
        "--reset-2fa",
      ].includes(arg) &&
      !(
        index > 0 &&
        ["--company", "--identifier", "--password-file"].includes(
          args[index - 1],
        )
      ),
  );
  if (unknown.length) fail(`خيار غير معروف: ${unknown[0]}`);

  let companyCode = valueOf("--company")?.trim();
  let identifier = valueOf("--identifier")?.trim();
  let confirmation = has("--confirm-break-glass") ? CONFIRM_PHRASE : "";

  if (!companyCode || !identifier || !confirmation) {
    if (!stdin.isTTY) {
      fail(
        "في الوضع غير التفاعلي يلزم --company و--identifier و--confirm-break-glass.",
      );
    }
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      companyCode ||= (
        await rl.question("رمز الشركة (أو single للنشر الأحادي): ")
      ).trim();
      identifier ||= (
        await rl.question("بريد/اسم مستخدم الأدمن المراد استعادته: ")
      ).trim();
      confirmation ||= (
        await rl.question(`اكتب ${CONFIRM_PHRASE} للتأكيد: `)
      ).trim();
    } finally {
      rl.close();
    }
  }
  if (confirmation !== CONFIRM_PHRASE) fail("عبارة تأكيد الطوارئ غير مطابقة.");
  if (!companyCode || !identifier) fail("رمز الشركة ومعرّف الأدمن مطلوبان.");

  const passwordFile = valueOf("--password-file");
  if (passwordFile && has("--password-stdin"))
    fail("اختر مصدراً واحداً لكلمة المرور.");
  let password: string;
  if (passwordFile) {
    password = await readPasswordFile(passwordFile);
  } else if (has("--password-stdin")) {
    password = await readAllStdin();
  } else {
    password = await hiddenQuestion("كلمة المرور الجديدة (لن تظهر): ");
    const confirmationPassword = await hiddenQuestion("أعد كلمة المرور: ");
    if (password !== confirmationPassword) fail("كلمتا المرور غير متطابقتين.");
  }

  const resetTwoFactor = has("--reset-2fa");
  const execute = () =>
    recoverLastAdminAccess(identifier!, password, { resetTwoFactor });
  let result: Awaited<ReturnType<typeof recoverLastAdminAccess>>;
  if (isMultiTenantModeActive()) {
    if (companyCode === "single")
      fail("الخادم متعدد الشركات؛ يجب تحديد رمز الشركة الحقيقي.");
    const company = await resolveCompanyByCode(companyCode);
    if (!company) fail("الشركة غير موجودة أو معطّلة.");
    result = await withTenantDb(company.id, (db) => runWithCompany(company.id, db, execute));
  } else {
    if (companyCode !== "single") {
      fail("النشر أحادي الشركة؛ اكتب single صراحةً لتأكيد قاعدة الهدف.");
    }
    result = await execute();
  }

  stdout.write(
    `تمت استعادة حساب الأدمن #${result.userId} وإبطال جلساته ورموز الاستعادة${result.twoFactorReset ? " وتصفير المصادقة الثنائية" : ""}.\n`,
  );
  if (passwordFile) stdout.write("احذف ملف كلمة المرور المؤقت الآن.\n");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`فشلت الاستعادة: ${message}\n`);
  process.exitCode = 1;
} finally {
  await Promise.all([
    closeDb().catch(() => undefined),
    closeControlDb().catch(() => undefined),
  ]);
}
