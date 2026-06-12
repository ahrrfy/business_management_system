import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckIcon, CopyIcon, MessageCircleIcon, XIcon } from "lucide-react";
import { useState } from "react";

export interface CredentialsShareProps {
  name: string;
  email: string;
  password: string;
  phone?: string | null;
  appUrl?: string;
  onClose?: () => void;
}

const DEFAULT_URL = "https://srv1548487.hstgr.cloud";

/** بطاقة مشاركة بيانات الدخول — تعرض البريد والكلمة + زر واتساب + نسخ الكل. */
export function CredentialsShare({
  name,
  email,
  password,
  phone,
  appUrl = DEFAULT_URL,
  onClose,
}: CredentialsShareProps) {
  const [copied, setCopied] = useState(false);

  const message =
    `أهلاً ${name} 👋\n` +
    `حسابك في نظام الرؤية العربية جاهز:\n` +
    `🔗 ${appUrl}\n` +
    `📧 ${email}\n` +
    `🔑 ${password}\n` +
    `⚠️ سيُطلب منك تغيير كلمة المرور عند أول دخول.`;

  function openWhatsApp() {
    if (!phone) return;
    // إزالة + والمسافات للحصول على الرقم الدولي الخام
    const raw = phone.replace(/[^0-9]/g, "");
    const url = `https://wa.me/${raw}?text=${encodeURIComponent(message)}`;
    window.open(url, "_blank", "noopener,noreferrer");
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
        <CardTitle className="text-base text-emerald-700 dark:text-emerald-400">
          ✅ تمّ إنشاء الحساب بنجاح
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
          <div><span className="text-muted-foreground text-xs">البريد: </span><span dir="ltr">{email}</span></div>
          <div><span className="text-muted-foreground text-xs">كلمة المرور: </span><span dir="ltr" className="font-bold tracking-wider">{password}</span></div>
          <div><span className="text-muted-foreground text-xs">الرابط: </span><span dir="ltr">{appUrl}</span></div>
          <p className="text-xs text-amber-600 mt-1">⚠️ سيُطلب تغيير كلمة المرور عند أول دخول (صالحة 72 ساعة)</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={openWhatsApp}
            disabled={!phone}
            title={!phone ? "أضف رقم الهاتف أولاً لإرسال واتساب" : undefined}
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

        {!phone && (
          <p className="text-xs text-amber-600">
            لا يوجد رقم هاتف لهذا المستخدم — أضفه في بيانات الحساب لتفعيل إرسال الواتساب.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
