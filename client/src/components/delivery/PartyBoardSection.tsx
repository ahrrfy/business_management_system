/**
 * الغلاف المتّصل للوحة الخمسة أعمدة (م١ PR-C): يجلب `delivery.partyBoard`، يفتح «سوِّ اليوم» بمعاينة
 * `delivery.settlementPreview` وينفّذ `delivery.settleDaily` ثمّ يُبطل الاستعلامات كي تصفر الأعمدة.
 * تستهلكه «جهات التوصيل» (بدل جدولها القديم) و«إدارة التوصيل» (تبويب «اللوحة»).
 *
 * الصلاحية مرآةُ `deliveryCashierProcedure` (store:FULL بكاشير/مدير) بما فيها المنح الصريح — غيابُها
 * يُخفي «سوِّ اليوم» لا يعطّله؛ والإنفاذ النهائيّ خادميّ دائماً.
 */
import { useState, type ComponentProps } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { errMsg, notify } from "@/lib/notify";
import { moduleAccessAllowed, type PermissionMap, type RoleKey } from "@shared/permissions";
import { PartyBoard } from "./PartyBoard";
import { DailySettlementDialog } from "./DailySettlementDialog";
import { partyDetailLinkFor, type PartyBoardRow } from "./partyBoardModel";
import type { SettleDailyPayload } from "./dailySettlement";

export interface PartyBoardSectionProps {
  outstandingOnly?: boolean;
  /** وردية الدرج التي يدخلها النقد المُورَّد (الاستقبال افتراضياً — كتسوية المناديب). */
  shiftType?: "RETAIL" | "RECEPTION";
  onOpenDetail?: (row: PartyBoardRow) => void;
  onSettleLoose?: (row: PartyBoardRow) => void;
  onWriteOff?: (row: PartyBoardRow) => void;
  contactFor?: ComponentProps<typeof PartyBoard>["contactFor"];
}

export function PartyBoardSection({ outstandingOnly = false, shiftType = "RECEPTION", onOpenDetail, onSettleLoose, onWriteOff, contactFor }: PartyBoardSectionProps) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.role as RoleKey | undefined;
  const override = (me.data?.permissionsOverride ?? null) as PermissionMap | null;
  const hasSettleRole = !!role && moduleAccessAllowed(role, override, "store", "FULL", ["cashier", "manager"]);
  // فرعُ التسوية = فرعُ الفاعل المُسنَد. غيابُه (أدمن/مالك عابرُ الفروع) ⇒ اللوحةُ مجمَّعةٌ لكلّ الفروع بينما
  // النقدُ يدخل درجَ فرعٍ بعينه: نحجب «سوِّ اليوم» حتى لا تُفتَح معاينةٌ فرعُها ≠ فرعُ صفوف اللوحة (Codex #1012 P2).
  const settleBranchId = me.data?.branchId ?? null;
  const canSettle = hasSettleRole && settleBranchId != null;
  // علَما الطرح التدريجيّ (مصدر الحقيقة: الخادم): يحكمان عرضَ «نقد بيده» في اللوحة (المصدر الفعّال).
  const uiFlags = trpc.delivery.deliveryUiFlags.useQuery(undefined, { staleTime: 5 * 60_000 });
  const ledgerDerived = uiFlags.data?.courierLedgerDerived ?? false;
  const board = trpc.delivery.partyBoard.useQuery(undefined, { refetchInterval: 30_000 });
  const [settleFor, setSettleFor] = useState<PartyBoardRow | null>(null);
  const preview = trpc.delivery.settlementPreview.useQuery(
    { partyId: settleFor?.partyId ?? 0, branchId: settleBranchId ?? undefined },
    { enabled: settleFor != null && settleBranchId != null, staleTime: 0 },
  );
  const settle = trpc.delivery.settleDaily.useMutation();

  const invalidateAll = () =>
    Promise.all([
      utils.delivery.partyBoard.invalidate(),
      utils.delivery.listParties.invalidate(),
      utils.delivery.obligations.invalidate(),
      utils.delivery.staleParties.invalidate(),
      utils.delivery.inTransit.invalidate(),
      utils.delivery.openConsignments.invalidate(),
      utils.delivery.remittances.invalidate(),
      utils.delivery.settlementPreview.invalidate(),
    ]);

  const onSettle = async (payload: SettleDailyPayload) => {
    try {
      // نُرسل فرعَ الفاعل صراحةً كي تطابق التسويةُ الفرعَ الذي عُرضت عليه المعاينة (لا الاشتقاق الخادميّ).
      const res = await settle.mutateAsync({ ...payload, branchId: settleBranchId ?? undefined });
      notify.ok(res.status === "BALANCED" ? "أُقفل اليوم مطابقاً" : "أُقفل اليوم بعجزٍ مُصنَّف", `سند التوريد #${res.remittanceId}`);
      await invalidateAll();
      return res;
    } catch (error: unknown) {
      // الزيادة وغيرها: رسالة الخادم كما هي — الحوار يعرضها بلا تفسيرٍ محلّيّ.
      throw new Error(errMsg(error));
    }
  };

  return (
    <>
      <PartyBoard
        rows={board.data}
        loading={board.isLoading}
        isError={board.isError}
        errorMessage={board.isError ? errMsg(board.error) : null}
        onRetry={() => void board.refetch()}
        outstandingOnly={outstandingOnly}
        ledgerDerived={ledgerDerived}
        onSettleToday={canSettle ? (row) => setSettleFor(row) : undefined}
        onOpenDetail={onOpenDetail ?? ((row) => navigate(partyDetailLinkFor(row)))}
        onSettleLoose={onSettleLoose}
        onWriteOff={onWriteOff}
        contactFor={contactFor}
      />
      <DailySettlementDialog
        party={settleFor ? { id: settleFor.partyId, name: settleFor.partyName } : null}
        open={settleFor != null}
        onOpenChange={(open) => { if (!open) setSettleFor(null); }}
        preview={preview.data}
        previewLoading={preview.isLoading}
        previewError={preview.isError ? errMsg(preview.error) : null}
        onRetryPreview={() => void preview.refetch()}
        shiftType={shiftType}
        onSettle={onSettle}
      />
    </>
  );
}
