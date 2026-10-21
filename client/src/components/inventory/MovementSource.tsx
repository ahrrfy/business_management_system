import { canLifecycleOperation } from "@/lib/lifecycleOperationAccess";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Link } from "wouter";

type Source = NonNullable<
  RouterOutputs["inventory"]["movementsRich"]["rows"][number]["stocktakeSource"]
>;

export function movementSourceLabel(source: Source): string {
  return source.sessionType === "OPENING"
    ? "رصيد آلي من اعتماد الجرد الافتتاحي"
    : "تسوية آلية من اعتماد الجرد";
}

export function movementDecisionLabel(source: Source): string {
  return source.autoApplied === true
    ? "تلقائي"
    : (source.decidedByName ?? "غير مسجّل");
}

/** One description for the screen, copied value, Excel and printed report. */
export function movementSourceText(source: Source): string {
  return `${movementSourceLabel(source)} ${source.code} · المعتمد النهائي: ${source.approvedByName ?? "غير مسجّل"} · العادّ: ${source.countedByName ?? "غير مسجّل"} · قرار الفرق: ${movementDecisionLabel(source)}`;
}

export function MovementSource({ source }: { source: Source }) {
  const me = trpc.auth.me.useQuery();
  const legacyAllowed =
    me.data?.isOwner === true ||
    ["admin", "manager", "warehouse"].includes(me.data?.role ?? "");
  const canOpen = canLifecycleOperation(
    me.data,
    "stocktakes.get",
    legacyAllowed,
  );
  return (
    <div className="space-y-0.5 text-xs">
      <div>{movementSourceLabel(source)}</div>
      {canOpen ? (
        <Link
          href={`/inventory?tab=stocktakes&focus=${source.sessionId}`}
          className="text-primary underline underline-offset-2"
        >
          {source.code}
        </Link>
      ) : (
        <span>{source.code}</span>
      )}
      <div className="text-muted-foreground">
        المعتمد النهائي: {source.approvedByName ?? "غير مسجّل"}
      </div>
      <div className="text-muted-foreground">
        العادّ: {source.countedByName ?? "غير مسجّل"}
      </div>
      <div className="text-muted-foreground">
        قرار الفرق: {movementDecisionLabel(source)}
      </div>
    </div>
  );
}
