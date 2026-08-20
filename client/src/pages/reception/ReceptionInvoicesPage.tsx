/**
 * **شاشة «فواتير للتحصيل»** — شاشةٌ قائمةٌ بذاتها (١٩/٨، طلب المالك).
 *
 * كانت لوحةً **داخل** شاشة الكاشير تُفتَح بزرٍّ في رأسها. وبلاغ المالك دقيق: بطاقةٌ تُعيدك
 * إلى الشاشة الرئيسية ليست فصلاً — بل تُضيف طبقةَ تكرارٍ ثالثة (زرٌّ في الرأس + بطاقةٌ في
 * الرئيسية + لوحةٌ داخل السلّة) فتفشل المعالجة. لكل مفهومٍ **شاشةٌ واحدة**.
 *
 * وغرضُها في اسمها: تفتح على **غير المسدَّدة** لا على كل الفواتير — «للتحصيل» تعني ما عليه
 * تحصيل. والصورةُ الشاملة مكانها صفحة المبيعات في الشريط الجانبيّ.
 */
import { useMemo } from "react";
import { Receipt } from "lucide-react";
import { trpc } from "@/lib/trpc";
import ReceptionInvoiceQueue from "@/components/reception/ReceptionInvoiceQueue";
import StationPageHeader from "@/components/StationPageHeader";
import type { DispatchParty } from "@/components/delivery/DispatchDialog";

export default function ReceptionInvoicesPage() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId != null ? Number(me.data.branchId) : null;
  const isElevatedRole = me.data?.role === "admin" || me.data?.role === "manager";

  const branchesQ = trpc.branches.list.useQuery();
  const branchName = useMemo(
    () => (branchesQ.data ?? []).find((b) => Number(b.id) === branchId)?.name ?? `فرع #${branchId ?? "—"}`,
    [branchesQ.data, branchId],
  );
  // الوردية ليست حالةً محلّيةً للمحطّة بل استعلامٌ خادميّ — فالقبض في الدرج يعمل من هنا
  // كما يعمل من السلّة تماماً (وغيابُها يُعلَن في الصفّ نفسه لا يُخفى).
  const shiftQ = trpc.shifts.current.useQuery(
    { branchId: branchId ?? 0, shiftType: "RECEPTION" },
    { enabled: branchId != null },
  );
  const partiesQ = trpc.delivery.listParties.useQuery({ activeOnly: true }, { staleTime: 60_000 });

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5">
      <StationPageHeader
        title="فواتير للتحصيل"
        description="فواتير محطّتك التي عليها مبلغٌ متبقٍّ — اقبض من الصفّ مباشرةً، أو أسنِد الطلب لجهة توصيل. الصورة الشاملة لكل الفواتير في «المبيعات»."
        Icon={Receipt}
      />
      {branchId == null ? (
        <NoBranchNotice />
      ) : (
      <ReceptionInvoiceQueue
        branchId={branchId}
        currentShiftId={shiftQ.data ? Number(shiftQ.data.id) : null}
        branchName={branchName}
        parties={(partiesQ.data ?? []) as DispatchParty[]}
        canFulfill={me.data?.role === "cashier" || isElevatedRole}
        isManager={isElevatedRole}
        defaultPayChip="UNSETTLED"
      />
      )}
    </div>
  );
}

/**
 * ⛔ **لا `?? 1`** (حارس `check:branch`): الفرع الافتراضيّ الصامت بابُ IDOR تاريخيّ — مديرٌ بلا
 * فرعٍ مُسنَد كان سيرى بيانات الفرع الأوّل ظانّاً أنّها فرعُه. الغيابُ يُعلَن ولا يُسقَط عليه.
 */
function NoBranchNotice() {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <p className="text-sm font-bold">لا فرع مُسنَد لحسابك</p>
      <p className="mt-1 text-xs text-muted-foreground">
        هذه الشاشة تعرض عمل فرعٍ بعينه — راجع المدير لإسناد فرعك، أو افتح الشاشة من محطّة الفرع.
      </p>
    </div>
  );
}
