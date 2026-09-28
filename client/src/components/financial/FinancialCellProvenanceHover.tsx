import React from "react";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  FileText,
  Layers,
  Receipt,
  Scale,
  Tag,
  Truck,
  UserRound,
} from "lucide-react";

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { formatIqd } from "@/lib/money";
import { cn } from "@/lib/utils";
import {
  computeProvenanceReconciliation,
  PROVENANCE_DOC_LABELS,
  PROVENANCE_MOVEMENT_LABELS,
  PROVENANCE_PARTY_LABELS,
  type FinancialCellProvenancePayload,
  type ProvenanceMovementType,
  type ProvenancePartyKind,
  type ProvenanceDocType,
} from "@shared/financialProvenance";

export interface FinancialCellProvenanceHoverProps {
  data?: FinancialCellProvenancePayload | null;
  children: React.ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  disabled?: boolean;
}

interface MovementStyle {
  label: string;
  icon: LucideIcon;
  textColor: string;
  bgColor: string;
  borderColor: string;
}

const MOVEMENT_CONFIG: Record<ProvenanceMovementType, MovementStyle> = {
  revenue: { label: PROVENANCE_MOVEMENT_LABELS.revenue, icon: ArrowDownLeft, textColor: "text-[var(--sem-pos)]", bgColor: "bg-[var(--sem-pos-bg)]", borderColor: "border-[var(--sem-pos)]/20" },
  expense: { label: PROVENANCE_MOVEMENT_LABELS.expense, icon: ArrowUpRight, textColor: "text-[var(--sem-neg)]", bgColor: "bg-[var(--sem-neg-bg)]", borderColor: "border-[var(--sem-neg)]/20" },
  collection: { label: PROVENANCE_MOVEMENT_LABELS.collection, icon: ArrowDownLeft, textColor: "text-[var(--sem-pos)]", bgColor: "bg-[var(--sem-pos-bg)]", borderColor: "border-[var(--sem-pos)]/20" },
  delivery: { label: PROVENANCE_MOVEMENT_LABELS.delivery, icon: ArrowUpRight, textColor: "text-[var(--sem-neg)]", bgColor: "bg-[var(--sem-neg-bg)]", borderColor: "border-[var(--sem-neg)]/20" },
  balance: { label: PROVENANCE_MOVEMENT_LABELS.balance, icon: Scale, textColor: "text-[var(--sem-info)]", bgColor: "bg-[var(--sem-info-bg)]", borderColor: "border-[var(--sem-info)]/20" },
  difference: { label: PROVENANCE_MOVEMENT_LABELS.difference, icon: AlertTriangle, textColor: "text-[var(--sem-warn)]", bgColor: "bg-[var(--sem-warn-bg)]", borderColor: "border-[var(--sem-warn)]/20" },
};

function getPartyIcon(kind?: ProvenancePartyKind): LucideIcon {
  if (kind === "supplier") return Truck;
  if (kind === "entity" || kind === "branch") return Building2;
  return UserRound;
}

function getDocIcon(type?: ProvenanceDocType): LucideIcon {
  if (type === "receipt" || type === "voucher" || type === "expense") return Receipt;
  if (type === "shift") return Layers;
  if (type === "journal_entry") return Scale;
  return FileText;
}

/**
 * بطاقة كشف الهوية المالية والتفاصيل الفورية (Financial Cell Provenance Hover Card)
 * مكون عام وموحد يعرض أصل وتفاصيل كل رقم مالي بالدينار العراقي مع المطابقة المحاسبية 100%.
 */
export function FinancialCellProvenanceHover({
  data,
  children,
  align = "center",
  side = "top",
  className,
  disabled = false,
}: FinancialCellProvenanceHoverProps) {
  if (!data || disabled) {
    return <>{children}</>;
  }

  const movement = data.movementType || "balance";
  const config = MOVEMENT_CONFIG[movement] ?? MOVEMENT_CONFIG.balance;
  const MovementIcon = config.icon;
  const recon = data.reconciliation ?? computeProvenanceReconciliation(data.totalAmount, data.subItems);

  const partyKind = data.party?.kind ?? data.party?.type;
  const PartyIcon = getPartyIcon(partyKind);
  const partyLabel = (partyKind && PROVENANCE_PARTY_LABELS[partyKind]) || "الطرف";

  const mainDoc = data.documentRef ?? (data.docRefs && data.docRefs.length > 0 ? data.docRefs[0] : null);
  const docType = mainDoc?.docType;
  const DocIcon = getDocIcon(docType);
  const docLabel = mainDoc?.label || (docType && PROVENANCE_DOC_LABELS[docType]) || "مستند";
  const docNumber = mainDoc?.docNumber || mainDoc?.number;

  const hasSubItems = Boolean(data.subItems && data.subItems.length > 0);
  const formattedTotal = data.formattedAmount || formatIqd(data.totalAmount);
  const actorName = data.actorName || data.actor?.name;
  const shiftText = data.shiftInfo?.shiftId ? `وردية #${data.shiftInfo.shiftId}` : null;
  const auditDetails = [actorName, shiftText, data.branchName].filter(Boolean).join(" · ");
  const classification = [data.category, data.classification, data.paymentMethod, data.cashBucket]
    .filter(Boolean)
    .join(" · ");

  return (
    <HoverCard openDelay={100} closeDelay={150}>
      <HoverCardTrigger asChild>
        {React.isValidElement(children) ? (
          children
        ) : (
          <span className="inline-block cursor-pointer">{children}</span>
        )}
      </HoverCardTrigger>
      <HoverCardContent
        dir="rtl"
        align={align}
        side={side}
        className={cn(
          "w-80 p-0 text-start overflow-hidden border border-border/80 shadow-xl rounded-lg bg-popover text-popover-foreground z-50",
          className
        )}
      >
        {/* رأس البطاقة */}
        <div className="p-3 bg-muted/40 border-b border-border/60">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <span
                className={cn(
                  "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold border",
                  config.textColor,
                  config.bgColor,
                  config.borderColor
                )}
              >
                <MovementIcon className="size-3 shrink-0" aria-hidden="true" />
                {config.label}
              </span>
              <h4 className="text-xs font-bold text-foreground mt-1 truncate">{data.title}</h4>
            </div>
            <div className="text-end shrink-0">
              <div className="text-[10px] text-muted-foreground font-medium">المبلغ الإجمالي</div>
              <div className={cn("text-sm font-bold font-mono tabular-nums", config.textColor)}>
                {formattedTotal}
              </div>
            </div>
          </div>
        </div>

        {/* قسم التفاصيل */}
        <div className="p-3 space-y-2 text-xs border-b border-border/40 bg-background/50">
          {data.party?.name && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <PartyIcon className="size-3.5 text-muted-foreground/80 shrink-0" aria-hidden="true" />
                {partyLabel}
              </span>
              <span className="font-medium text-foreground truncate max-w-[170px]" title={data.party.name}>
                {data.party.name}
              </span>
            </div>
          )}
          {docNumber && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <DocIcon className="size-3.5 text-muted-foreground/80 shrink-0" aria-hidden="true" />
                {docLabel}
              </span>
              <span className="font-mono font-medium text-foreground dir-ltr">{docNumber}</span>
            </div>
          )}
          {classification && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Tag className="size-3.5 text-muted-foreground/80 shrink-0" aria-hidden="true" />
                التصنيف
              </span>
              <span className="font-medium text-foreground truncate max-w-[170px]" title={classification}>
                {classification}
              </span>
            </div>
          )}
          {data.contraAccount && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Scale className="size-3.5 text-muted-foreground/80 shrink-0" aria-hidden="true" />
                الحساب المقابل
              </span>
              <span className="font-mono font-medium text-foreground truncate max-w-[170px]">
                {data.contraAccount.code} - {data.contraAccount.name}
              </span>
            </div>
          )}
          {auditDetails && (
            <div className="pt-1 text-[10px] text-muted-foreground border-t border-border/30 truncate">
              {auditDetails}
            </div>
          )}
        </div>

        {/* قسم البنود الفرعية */}
        {hasSubItems && data.subItems && (
          <div className="p-2 border-b border-border/40">
            <div className="flex items-center justify-between px-1 mb-1.5 text-[11px] font-semibold text-muted-foreground">
              <span className="flex items-center gap-1">
                <Layers className="size-3 shrink-0" aria-hidden="true" />
                تفاصيل البنود ({data.subItems.length})
              </span>
              <span>المبلغ</span>
            </div>
            <div className="max-h-60 overflow-y-auto divide-y divide-border/30 rounded border border-border/40 bg-muted/10">
              {data.subItems.map((item, idx) => (
                <div key={item.id ?? idx} className="flex items-center justify-between p-1.5 text-xs hover:bg-muted/30 transition-colors">
                  <div className="min-w-0 flex-1 pe-2">
                    <div className="font-medium text-foreground truncate">{item.label}</div>
                    {(item.quantity != null || item.unitPrice != null || item.note) && (
                      <div className="text-[10px] text-muted-foreground truncate">
                        {item.quantity != null && `${item.quantity} × `}
                        {item.unitPrice != null && formatIqd(item.unitPrice)}
                        {item.note && ` (${item.note})`}
                      </div>
                    )}
                  </div>
                  <div className="font-mono font-semibold tabular-nums text-foreground shrink-0">
                    {formatIqd(item.amount)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* تنبيهات التدقيق */}
        {data.warnings && data.warnings.length > 0 && (
          <div className="p-2 space-y-1 bg-[var(--sem-warn-bg)]/40 border-b border-[var(--sem-warn)]/20">
            {data.warnings.map((w, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[11px] text-[var(--sem-warn)] font-medium">
                <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        {/* ملاحظات */}
        {(data.notes || data.note) && (
          <div className="px-3 py-1.5 text-[11px] text-muted-foreground italic border-b border-border/30 bg-muted/10">
            {data.notes || data.note}
          </div>
        )}

        {/* ذيل المطابقة المحاسبية 100% */}
        {hasSubItems && (
          <div
            className={cn(
              "flex items-center justify-between px-3 py-2 text-xs font-semibold",
              recon.isFullyReconciled
                ? "bg-[var(--sem-pos-bg)] text-[var(--sem-pos)]"
                : "bg-[var(--sem-warn-bg)] text-[var(--sem-warn)]"
            )}
          >
            <span className="flex items-center gap-1.5">
              {recon.isFullyReconciled ? (
                <>
                  <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
                  مطابقة تامة للبنود (100%)
                </>
              ) : (
                <>
                  <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                  تفاوت: {formatIqd(recon.discrepancy)}
                </>
              )}
            </span>
            <span className="font-mono font-bold tabular-nums">
              {formatIqd(recon.subItemsSum)}
            </span>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
