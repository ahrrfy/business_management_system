import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/PageState";
import { confirm } from "@/lib/confirm";
import { fmtDateTime } from "@/lib/date";
import { notify } from "@/lib/notify";
import { trpc } from "@/lib/trpc";
import { SecretField } from "@/components/integrations/SecretField";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Scissors,
  Trash2,
  Wand2,
} from "lucide-react";

/**
 * بطاقة «استوديو صور المنتجات» (remove.bg) — مسار Pro لقصّ خلفية الصور احترافياً. المفتاح مشفّر
 * (نفس INTEGRATIONS_ENCRYPTION_KEY). عند التعطيل/نفاد الرصيد يعمل المسار المجاني الآمن تلقائياً.
 * أمانة صارمة: remove.bg قصّ لا توليد (بكسلات المنتج تبقى).
 */
export function ImageStudioIntegrationCard() {
  const settings = trpc.imageStudio.settings.useQuery();
  const utils = trpc.useUtils();
  const [keyDraft, setKeyDraft] = useState("");
  const update = trpc.imageStudio.updateSettings.useMutation({
    onSuccess: () => { notify.ok("تم الحفظ"); utils.imageStudio.settings.invalidate(); setKeyDraft(""); },
    onError: (e) => notify.err(e),
  });
  const verify = trpc.imageStudio.verifyConnection.useMutation({
    onSuccess: (r) => { (r.ok ? notify.ok : notify.warn)(r.ok ? "المفتاح صالح" : "فشل الفحص", r.message); utils.imageStudio.settings.invalidate(); },
    onError: (e) => notify.err(e),
  });
  if (settings.isError) {
    return <ErrorState message="تعذّر تحميل إعدادات remove.bg." onRetry={() => void settings.refetch()} />;
  }
  if (settings.isLoading || !settings.data) return <LoadingState />;
  const s = settings.data;

  return (
    <Card className="border-violet-500/30 bg-violet-500/[0.03]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-10 rounded-lg grid place-items-center flex-shrink-0 border bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/30">
              <Scissors aria-hidden className="size-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">استوديو صور المنتجات — remove.bg</CardTitle>
              <div className="text-xs text-muted-foreground mt-0.5">قصّ خلفية احترافيّ لصور المنتجات (Pro اختياريّ مدفوع)</div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={s?.proEnabled ? "badge-status-active" : "badge-status-cancelled"}>
              {s?.proEnabled ? "Pro مفعّل" : "Pro معطّل"}
            </Badge>
            {s?.lastVerifiedAt && (
              <span className="text-[10px] text-muted-foreground" dir="ltr">آخر فحص {fmtDateTime(s.lastVerifiedAt)}</span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground space-y-1">
          <p>قصّ احترافيّ للخلفية عبر remove.bg — <b>قصّ لا توليد</b> ⇒ بكسلات منتجك تبقى كما هي. مجانيّ حتى ~50 صورة/شهر (دقّة معاينة منخفضة)، ثمّ مدفوع بالرصيد.</p>
          <p>المفتاح من: remove.bg ← Dashboard ← <span dir="ltr">API Keys</span>. عند التعطيل أو نفاد الرصيد يعمل المسار المجانيّ الآمن (FLATTEN) تلقائياً.</p>
        </div>

        {s?.lastError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs flex items-start gap-2">
            <AlertCircle aria-hidden className="size-4 text-destructive flex-shrink-0 mt-0.5" />
            <div className="text-destructive break-words">{s.lastError}</div>
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <SecretField
              label="مفتاح remove.bg API"
              hint="الصق مفتاحاً جديداً ليشفّر ويحفظ. اتركه فارغاً لإبقاء الحاليّ."
              masked={s?.removebgKeyMasked ?? null}
              value={keyDraft}
              onChange={setKeyDraft}
              placeholder="الصق مفتاح remove.bg"
            />
          </div>
          <Button onClick={() => update.mutate({ removebgKey: keyDraft.trim() })} disabled={update.isPending || !keyDraft.trim()}>
            {update.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : null}
            حفظ المفتاح
          </Button>
        </div>

        <div className="flex gap-2 flex-wrap pt-1">
          <Button
            variant="outline"
            onClick={() => verify.mutate()}
            disabled={verify.isPending || !s?.hasKey}
          >
            {verify.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4 me-1" />}
            فحص الاتصال والرصيد
          </Button>
          {s?.proEnabled ? (
            <Button variant="outline" onClick={() => update.mutate({ proEnabled: false })} disabled={update.isPending}>
              تعطيل Pro
            </Button>
          ) : (
            <Button variant="outline" onClick={() => update.mutate({ proEnabled: true })} disabled={update.isPending || !s?.hasKey} title={!s?.hasKey ? "أدخل المفتاح أوّلاً" : undefined}>
              تفعيل Pro
            </Button>
          )}
          {s?.hasKey && (
            <Button
              variant="ghost"
              className="text-destructive hover:bg-destructive/10"
              onClick={async () => {
                if (!(await confirm({
                  variant: "danger",
                  title: "حذف مفتاح remove.bg",
                  description: "سيحذف المفتاح ويعطّل مسار Pro. سيعمل المسار المجانيّ الآمن. متابعة؟",
                  confirmText: "حذف",
                  cancelText: "تراجع",
                }))) return;
                update.mutate({ removebgKey: null });
              }}
              disabled={update.isPending}
            >
              <Trash2 aria-hidden className="size-4 me-1" /> حذف المفتاح
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * بطاقة «استوديو الذكاء الاصطناعي» — إعادة تصميم صورة المنتج كاستوديو موحّد من برومت جاهز (Gemini/أي
 * مزوّد). المفتاح مشفّر (نفس INTEGRATIONS_ENCRYPTION_KEY). ⚠️ توليديّ (يعيد رسم البكسلات): يخضع
 * لمراجعة/اعتماد بشريّ في نموذج المنتج قبل استبدال الأصل، والأصل يبقى دائماً. معطّل افتراضياً.
 */
export function AiImageStudioIntegrationCard() {
  const aiSettings = trpc.imageStudio.aiSettings.useQuery();
  const utils = trpc.useUtils();
  const [keyDraft, setKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);

  const update = trpc.imageStudio.updateAiSettings.useMutation({
    onSuccess: () => {
      notify.ok("تم الحفظ");
      utils.imageStudio.aiSettings.invalidate();
      utils.imageStudio.aiConfig.invalidate();
      setKeyDraft("");
    },
    onError: (e) => notify.err(e),
  });
  const verify = trpc.imageStudio.verifyAiConnection.useMutation({
    onSuccess: (r) => { (r.ok ? notify.ok : notify.warn)(r.ok ? "المفتاح صالح" : "فشل الفحص", r.message); utils.imageStudio.aiSettings.invalidate(); },
    onError: (e) => notify.err(e),
  });
  if (aiSettings.isError) {
    return <ErrorState message="تعذّر تحميل إعدادات خدمة الصور التوليدية." onRetry={() => void aiSettings.refetch()} />;
  }
  if (aiSettings.isLoading || !aiSettings.data) return <LoadingState />;
  const s = aiSettings.data;
  const modelValue = modelDraft ?? s?.aiModel ?? "";
  const promptValue = promptDraft ?? s?.aiStudioPrompt ?? "";

  return (
    <Card className="border-fuchsia-500/30 bg-fuchsia-500/[0.03]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-10 rounded-lg grid place-items-center flex-shrink-0 border bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-500/30">
              <Wand2 aria-hidden className="size-5" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">استوديو الذكاء الاصطناعي — {s?.aiProvider ?? "Gemini"}</CardTitle>
              <div className="text-xs text-muted-foreground mt-0.5">إعادة تصميم صور المنتجات كاستوديو موحّد من برومت جاهز (اختياريّ مدفوع)</div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={s?.aiEnabled ? "badge-status-active" : "badge-status-cancelled"}>
              {s?.aiEnabled ? "مفعّل" : "معطّل"}
            </Badge>
            {s?.aiLastVerifiedAt && (
              <span className="text-[10px] text-muted-foreground" dir="ltr">آخر فحص {fmtDateTime(s.aiLastVerifiedAt)}</span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground space-y-1">
          <p>يعيد تصميم صورة المنتج كتصوير استوديو موحّد (خلفية بيضاء + إضاءة + ظلّ) — <b>كأنّ كل الصور من استوديو واحد</b>. برومت جاهز محصّن يأمر بحفظ المنتج وكتابته.</p>
          <p className="flex items-start gap-1.5 text-[var(--sem-warn)] dark:text-[var(--sem-warn)]">
            <AlertTriangle aria-hidden className="size-3.5 shrink-0 mt-0.5" />
            <span>توليديّ (يعيد رسم الصورة، بخلاف remove.bg القاصّ) ⇒ قد يغيّر تفاصيل دقيقة/كتابة. لذلك النتيجة تعرض للمراجعة والاعتماد قبل استبدال الأصل، <b>والأصل يبقى دائماً</b>.</span>
          </p>
          <p>مفتاح Gemini من: <span dir="ltr">Google AI Studio ← Get API key</span>. النموذج الافتراضيّ السريع والاقتصادي <span dir="ltr">{s?.aiModelEffective ?? "gemini-3.1-flash-lite-image"}</span>.</p>
        </div>

        {s?.aiLastError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs flex items-start gap-2">
            <AlertCircle aria-hidden className="size-4 text-destructive flex-shrink-0 mt-0.5" />
            <div className="text-destructive break-words">{s.aiLastError}</div>
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <SecretField
              label="مفتاح API للذكاء الاصطناعي"
              hint="الصق مفتاحاً جديداً ليشفّر ويحفظ. اتركه فارغاً لإبقاء الحاليّ."
              masked={s?.aiKeyMasked ?? null}
              value={keyDraft}
              onChange={setKeyDraft}
              placeholder="الصق مفتاح Gemini"
            />
          </div>
          <Button onClick={() => update.mutate({ aiKey: keyDraft.trim() })} disabled={update.isPending || !keyDraft.trim()}>
            {update.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : null}
            حفظ المفتاح
          </Button>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium">النموذج (اختياري)</label>
            <div className="text-[11px] text-muted-foreground">اتركه فارغاً للافتراضيّ. غيّره فقط لنموذج أحدث من نفس المزوّد.</div>
            <input
              type="text"
              value={modelValue}
              onChange={(e) => setModelDraft(e.target.value)}
              placeholder="gemini-3.1-flash-lite-image"
              dir="ltr"
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => update.mutate({ aiModel: modelValue.trim() || null }, { onSuccess: () => setModelDraft(null) })}
            disabled={update.isPending}
          >
            حفظ النموذج
          </Button>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs font-medium">البرومت الجاهز للاستوديو</label>
            {s?.aiStudioPromptIsDefault && <Badge variant="outline" className="text-[10px]">الافتراضيّ</Badge>}
          </div>
          <div className="text-[11px] text-muted-foreground">يصف الخلفية والإضاءة والإطار الموحّد. حارس حفظ المنتج مبنيّ في النظام ولا يلغى بهذا النصّ.</div>
          <textarea
            value={promptValue}
            onChange={(e) => setPromptDraft(e.target.value)}
            rows={5}
            dir="ltr"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => update.mutate({ aiStudioPrompt: promptValue.trim() || null }, { onSuccess: () => setPromptDraft(null) })}
              disabled={update.isPending}
            >
              حفظ البرومت
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => update.mutate({ aiStudioPrompt: null }, { onSuccess: () => setPromptDraft(null) })}
              disabled={update.isPending || s?.aiStudioPromptIsDefault}
            >
              <RotateCcw aria-hidden className="size-3.5 me-1" /> استعادة الافتراضيّ
            </Button>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap pt-1 border-t mt-1">
          <Button
            variant="outline"
            onClick={() => verify.mutate()}
            disabled={verify.isPending || !s?.hasAiKey}
          >
            {verify.isPending ? <Loader2 aria-hidden className="size-4 me-1 animate-spin" /> : <CheckCircle2 aria-hidden className="size-4 me-1" />}
            فحص الاتصال
          </Button>
          {s?.aiEnabled ? (
            <Button variant="outline" onClick={() => update.mutate({ aiEnabled: false })} disabled={update.isPending}>
              تعطيل
            </Button>
          ) : (
            <Button variant="outline" onClick={() => update.mutate({ aiEnabled: true })} disabled={update.isPending || !s?.hasAiKey} title={!s?.hasAiKey ? "أدخل المفتاح أوّلاً" : undefined}>
              تفعيل
            </Button>
          )}
          {s?.hasAiKey && (
            <Button
              variant="ghost"
              className="text-destructive hover:bg-destructive/10"
              onClick={async () => {
                if (!(await confirm({
                  variant: "danger",
                  title: "حذف مفتاح الذكاء الاصطناعي",
                  description: "سيحذف المفتاح ويعطّل المسار. متابعة؟",
                  confirmText: "حذف",
                  cancelText: "تراجع",
                }))) return;
                update.mutate({ aiKey: null });
              }}
              disabled={update.isPending}
            >
              <Trash2 aria-hidden className="size-4 me-1" /> حذف المفتاح
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
