import { AlertCircle, CheckCircle2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { QuickStudioController } from "./useQuickStudioController";

export function QuickStudioProviderStatus({
  controller,
}: {
  controller: QuickStudioController;
}) {
  const {
    aiAvailable,
    proAvailable,
    aiConfig,
    aiUnavailableMessage,
    proUnavailableMessage,
  } = controller;
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-foreground flex items-center gap-1.5">
          <Sparkles aria-hidden className="size-3.5 text-primary" />
          جاهزية معالجة الذكاء الاصطناعي
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {aiAvailable ? (
            <Badge
              variant="outline"
              className="badge-status-active font-normal text-[11px] gap-1"
            >
              <CheckCircle2 aria-hidden className="size-3" />
              استوديو الذكاء ({aiConfig.data?.provider || "Gemini"}): جاهز
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="badge-stock-low font-normal text-[11px] gap-1"
              title={aiUnavailableMessage}
            >
              <AlertCircle aria-hidden className="size-3" />
              استوديو الذكاء: غير متاح
            </Badge>
          )}
          {proAvailable ? (
            <Badge
              variant="outline"
              className="badge-status-active font-normal text-[11px] gap-1"
            >
              <CheckCircle2 aria-hidden className="size-3" />
              عزل remove.bg: جاهز
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="border-muted bg-muted/40 text-muted-foreground font-normal text-[11px] gap-1"
              title={proUnavailableMessage}
            >
              <AlertCircle aria-hidden className="size-3" />
              عزل remove.bg: غير متاح
            </Badge>
          )}
        </div>
      </div>
      {(!aiAvailable || !proAvailable) && (
        <div className="rounded border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-300 space-y-1">
          {!aiAvailable && (
            <div className="flex items-start gap-1.5">
              <AlertCircle
                aria-hidden
                className="size-3.5 shrink-0 mt-0.5 text-amber-600"
              />
              <span>
                استوديو الذكاء ({aiConfig.data?.provider || "Gemini"}):{" "}
                {aiUnavailableMessage}
              </span>
            </div>
          )}
          {!proAvailable && (
            <div className="flex items-start gap-1.5">
              <AlertCircle
                aria-hidden
                className="size-3.5 shrink-0 mt-0.5 text-amber-600"
              />
              <span>عزل remove.bg: {proUnavailableMessage}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
