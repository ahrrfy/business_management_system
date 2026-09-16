/**
 * **رقاقةُ الخطوة التالية** — رأس صفحة تفاصيل المستند يقول للموظّف: **ماذا الآن، ومَن
 * يملكها، وأين تُنفَّذ، ومتى، وما الذي يمنعها الآن**.
 *
 * ## قرارات التصميم
 *
 * ١) **صفٌّ ظاهرٌ لا Toast**: هذه ليست إشعاراً عابراً — هي إجابةُ سؤالٍ يفتح المستخدم
 *    الصفحةَ من أجله. رقاقةٌ ثابتةٌ تحت رأس الصفحة أفضلُ من طرفٍ مطويّ يُقرأ ثانياً.
 * ٢) **لونٌ دلاليٌّ لا لونٌ خامّ** (حارس `check:colors`): `--sem-info` افتراضياً،
 *    و`--sem-warn` عند وجود موانع (يخبر بالعين أنّ الخطوة موجودة لكنّها محجوزة).
 * ٣) **أرقامٌ لاتينيّةٌ في كلّ نصّ يظهر رقماً** (حارس `check:locale-numbers`): «٤س»
 *    الهنديّة تُضاعف احتمال الخطأ عند قراءة السقف الزمنيّ.
 * ٤) **RTL كامل**: `dir="rtl"` على الحاوية، فينعكس ترتيب الأيقونة والنصّ والرابط بلا
 *    كتابةٍ يدويّة لِـ`flex-row-reverse` تنكسر عند تغيير خطّ التخطيط.
 * ٥) **رابطٌ إن وُجد**: `href` قد يغيب من `NextAction` عمداً (`SYSTEM` مثلاً) —
 *    نُخفي الرابطَ لا نُظهره فارغاً.
 * ٦) **بلا إيموجي**: `check:emoji` يمسح `client/**`؛ الأيقونة من `lucide-react` وحدها.
 */

import * as React from "react";
import { Link } from "wouter";
import { AlertTriangle, ArrowLeft, Clock, User2 } from "lucide-react";
import {
  isNextActionBlocked,
  nextActionOwnerLabel,
  type NextAction,
} from "@shared/nextAction";
import { cn } from "@/lib/utils";

/**
 * `terminalReason` يُعرَض حين `nextAction === null` — العقدُ يفرض أن يكون معلَناً دائماً
 * لهذه الحالة، فلا يترك الموظّفَ أمام مربّعٍ فارغ يقرؤه عطباً في النظام.
 */
export interface NextActionChipProps {
  nextAction: NextAction | null;
  /** سببُ انعدام الخطوة، من `nextActionTerminalReason(kind, status)`. لا يُعرَض إن غاب. */
  terminalReason?: string | null;
  /** اسمُ المستخدم حين يكون `owner.kind === "USER"` — يُغني عن قراءةٍ ثانية في العميل. */
  userName?: string | null;
  className?: string;
}

/**
 * رقاقةُ الخطوة التالية. تُعالج ثلاث حالاتٍ صريحة:
 *  · خطوةٌ قائمة ⇒ صفٌّ بلون `--sem-info` (أو `--sem-warn` عند وجود موانع).
 *  · خطوةٌ قائمةٌ محجوبةٌ ⇒ نفس الصفّ، بلون `--sem-warn`، مع قائمة موانعَ منقولةٍ نصّاً بنصّ.
 *  · لا خطوة ⇒ صفٌّ رماديٌّ يعرض `terminalReason`.
 */
export function NextActionChip({
  nextAction,
  terminalReason,
  userName,
  className,
}: NextActionChipProps): React.ReactElement | null {
  if (nextAction == null) {
    if (terminalReason == null || terminalReason.trim().length === 0) return null;
    return (
      <div
        dir="rtl"
        role="status"
        data-testid="next-action-chip-terminal"
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-sm text-muted-foreground",
          className,
        )}
      >
        <span className="font-medium">لا خطوة قادمة</span>
        <span className="text-xs">{terminalReason}</span>
      </div>
    );
  }

  const blocked = isNextActionBlocked(nextAction);
  const ownerLabel = nextActionOwnerLabel(nextAction.owner, userName);

  // Latin-digits SLA rendering — Number.toString on the number itself, avoid toLocaleString.
  const slaLabel =
    nextAction.slaHours != null
      ? nextAction.slaHours === 0
        ? "الآن"
        : `${nextAction.slaHours}س`
      : null;

  const toneClass = blocked
    ? "border-[var(--sem-warn)]/40 bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
    : "border-[var(--sem-info)]/40 bg-[var(--sem-info-bg)] text-[var(--sem-info)]";

  const OwnerIcon = nextAction.owner.kind === "USER" ? User2 : User2;

  const chipBody = (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-semibold">الخطوة التالية:</span>
      <span className="min-w-0 break-words">{nextAction.what}</span>
      <span className="inline-flex items-center gap-1 text-xs opacity-90">
        <OwnerIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="whitespace-nowrap">{ownerLabel}</span>
      </span>
      {slaLabel ? (
        <span className="inline-flex items-center gap-1 text-xs opacity-90">
          <Clock aria-hidden className="size-3.5 shrink-0" />
          <span dir="ltr" className="tabular-nums">
            {slaLabel}
          </span>
        </span>
      ) : null}
    </div>
  );

  const linkTail =
    nextAction.href != null ? (
      <Link
        href={nextAction.href}
        className="inline-flex items-center gap-1 self-start rounded-md border border-current/30 px-2 py-1 text-xs font-semibold hover:underline"
      >
        <span>افتح</span>
        <ArrowLeft aria-hidden className="size-3.5" />
      </Link>
    ) : null;

  return (
    <div
      dir="rtl"
      role="status"
      data-testid="next-action-chip"
      data-blocked={blocked ? "true" : "false"}
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm",
        toneClass,
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {chipBody}
        {blocked && nextAction.blockedBy != null && nextAction.blockedBy.length > 0 ? (
          <ul className="flex flex-col gap-1 ps-5 text-xs">
            {nextAction.blockedBy.map((line, i) => (
              <li
                key={i}
                className="flex items-start gap-1"
                data-testid="next-action-chip-blocker"
              >
                <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {linkTail}
    </div>
  );
}
