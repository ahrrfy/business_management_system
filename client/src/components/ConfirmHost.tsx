// مُضيف حوار التأكيد الموحّد — يُركَّب مرّة واحدة في main.tsx بجوار <Toaster/>.
// يستمع لطلبات confirm() من @/lib/confirm ويعرض AlertDialog منسّقاً (danger/warning/info + حارس كتابة الاسم).
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  _subscribeConfirm,
  type ConfirmRequest,
  type ConfirmVariant,
} from "@/lib/confirm";

type VariantMeta = {
  icon: typeof AlertTriangle;
  iconClass: string;
  confirmClass: string;
  defaultTitle: string;
};

const VARIANT_META: Record<ConfirmVariant, VariantMeta> = {
  danger: {
    icon: AlertTriangle,
    iconClass: "text-destructive",
    confirmClass: cn(buttonVariants({ variant: "destructive" })),
    defaultTitle: "تأكيد الحذف",
  },
  warning: {
    icon: AlertTriangle,
    iconClass: "text-amber-600",
    confirmClass: cn(buttonVariants()),
    defaultTitle: "تأكيد العملية",
  },
  info: {
    icon: Info,
    iconClass: "text-primary",
    confirmClass: cn(buttonVariants()),
    defaultTitle: "تأكيد",
  },
};

export function ConfirmHost() {
  const [current, setCurrent] = useState<ConfirmRequest | null>(null);
  const [typed, setTyped] = useState("");
  // مرجع متزامن لمنع الحلّ المزدوج (onClick ثم onOpenChange في نفس دورة الحدث).
  const currentRef = useRef<ConfirmRequest | null>(null);
  currentRef.current = current;

  useEffect(() => {
    return _subscribeConfirm((req) => {
      setCurrent((prev) => {
        if (prev) {
          // حوار مفتوح أصلاً — ارفض الطلب الجديد (طابور بطول ١، لا تكديس نوافذ).
          req.resolve(false);
          return prev;
        }
        return req;
      });
      setTyped("");
    });
  }, []);

  function settle(ok: boolean) {
    const req = currentRef.current;
    currentRef.current = null; // امنع الحلّ المزدوج فوراً
    if (req) req.resolve(ok);
    setCurrent(null);
    setTyped("");
  }

  const opts = current?.options;
  const variant = opts?.variant ?? "warning";
  const meta = VARIANT_META[variant];
  const Icon = meta.icon;
  const needsText = !!opts?.requireText;
  const canConfirm = !needsText || typed.trim() === (opts?.requireText ?? "").trim();

  return (
    <AlertDialog
      open={!!current}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader className="sm:text-right">
          <AlertDialogTitle className="flex items-center gap-2">
            <Icon className={cn("size-5 shrink-0", meta.iconClass)} />
            {opts?.title ?? meta.defaultTitle}
          </AlertDialogTitle>
          {opts?.description != null && (
            <AlertDialogDescription>{opts.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>

        {needsText && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {opts?.requireTextLabel ?? <>اكتب «{opts?.requireText}» للتأكيد</>}
            </Label>
            <Input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) settle(true);
              }}
              dir="auto"
            />
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {opts?.cancelText ?? "إلغاء"}
          </AlertDialogCancel>
          <AlertDialogAction
            className={meta.confirmClass}
            disabled={!canConfirm}
            onClick={() => settle(true)}
          >
            {opts?.confirmText ?? "تأكيد"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
