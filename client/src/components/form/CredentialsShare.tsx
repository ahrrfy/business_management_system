import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildCredentialsMessage, whatsappLink } from "@/lib/credentialsMessage";
import { AlertTriangle, CheckCircle2, CheckIcon, CopyIcon, MessageCircleIcon, XIcon } from "lucide-react";
import { useState } from "react";

export interface CredentialsShareProps {
  name: string;
  email: string;
  /** اسم المستخدم — معرّف دخول بديل/إضافي للبريد. */
  username?: string | null;
  password: string;
  phone?: string | null;
  /** تسمية الصلاحية بالعربية (مثل «كاشير»). */
  roleLabel?: string | null;
  /** اسم الفرع، أو فارغ ⇒ «كل الفروع». */
  branchName?: string | null;
  /** المسمّى الوظيفي. */
  jobTitle?: string | null;
  /** هل سيُجبَر على تغيير الكلمة عند أول دخول (يضبط نصّ التعليمات). */
  mustChangePassword?: boolean;
  appUrl?: string;
  onClose?: () => void;
}

const DEFAULT_URL = "https://srv1548487.hstgr.cloud";

/**
 * بطاقة مشاركة بيانات حساب مستخدم جديد — تعرض معلوماته وبيانات دخوله، وتُرسلها جاهزةً
 * إلى رقمه على واتساب (رسالة فيها بيانات الدخول + معلوماته + تعليمات أوّلية)، أو تنسخ النصّ.
 */
export function CredentialsShare({
  name,
  email,
  username,
  password,
  phone,
  roleLabel,
  branchName,
  jobTitle,
  mustChangePassword = true,
  appUrl = DEFAULT_URL,
  onClose,
}: CredentialsShareProps) {
  const [copied, setCopied] = useState(false);

  const message = buildCredentialsMessage({
    name,
    email,
    username,
    password,
    appUrl,
    roleLabel,
    branchName,
    jobTitle,
    mustChangePassword,
  });
  const waUrl = whatsappLink(phone, message);

  function openWhatsApp() {
    if (!waUrl) return;
    window.open(waUrl, "_blank", "noopener,noreferrer");
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // fallback: نسخ يدوي
    }
  }

  return (
    <Card className="border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-800">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-base text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
          <CheckCircle2 aria-hidden className="size-4" /> تمّ إنشاء الحساب بنجاح
        </CardTitle>
        {onClose && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md bg-white dark:bg-black/20 border p-3 font-mono text-sm space-y-1 text-right" dir="rtl">
          <div><span className="text-muted-foreground text-xs">الاسم: </span>{name}</div>
          {jobTitle?.trim() ? (
            <div><span className="text-muted-foreground text-xs">المسمّى: </span>{jobTitle}</div>
          ) : null}
          {roleLabel?.trim() ? (
            <div><span className="text-muted-foreground text-xs">الصلاحية: </span>{roleLabel}</div>
          ) : null}
          <div><span className="text-muted-foreground text-xs">الفرع: </span>{branchName?.trim() || "كل الفروع"}</div>
          {username?.trim() ? (
            <div><span className="text-muted-foreground text-xs">اسم المستخدم: </span><span dir="ltr">{username}</span></div>
          ) : null}
          {email?.trim() ? (
            <div><span className="text-muted-foreground text-xs">البريد: </span><span dir="ltr">{email}</span></div>
          ) : null}
          <div><span className="text-muted-foreground text-xs">كلمة المرور: </span><span dir="ltr" className="font-bold tracking-wider">{password}</span></div>
          <div><span className="text-muted-foreground text-xs">الرابط: </span><span dir="ltr">{appUrl}</span></div>
          {mustChangePassword && (
            <p className="text-xs text-amber-600 mt-1 inline-flex items-center gap-1"><AlertTriangle aria-hidden className="size-3.5" /> سيُطلب تغيير كلمة المرور عند أول دخول (صالحة 72 ساعة)</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={openWhatsApp}
            disabled={!waUrl}
            title={!waUrl ? "أضف رقم الهاتف أولاً لإرسال واتساب" : undefined}
            className="gap-1"
          >
            <MessageCircleIcon className="h-4 w-4 text-green-600" />
            إرسال واتساب
          </Button>

          <Button variant="outline" size="sm" onClick={copyAll} className="gap-1">
            {copied ? <CheckIcon className="h-4 w-4 text-emerald-600" /> : <CopyIcon className="h-4 w-4" />}
            {copied ? "تمّ النسخ!" : "نسخ الكل"}
          </Button>
        </div>

        {!waUrl && (
          <p className="text-xs text-amber-600">
            لا يوجد رقم هاتف لهذا المستخدم — أضفه في «البيانات الوظيفية» لتفعيل إرسال الواتساب (يبقى بإمكانك «نسخ الكل»).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
