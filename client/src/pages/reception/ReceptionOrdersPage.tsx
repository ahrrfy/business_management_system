/**
 * **شاشة «طلبات محطّتي»** — شاشةٌ قائمةٌ بذاتها (١٩/٨، طلب المالك).
 *
 * طابورُ التسليم والإسناد: ما وصل إلى «جاهز» بانتظار صاحبه، وما يُسنَد لمندوبٍ أو شركة.
 * وهي **ليست** لوحة الإنتاج (`/work-orders`): تلك كانبانُ المراحل لمن ينفّذ، وهذه طابورُ
 * المخرَج لمن يسلّم. اسمان مختلفان لأنّهما عملان مختلفان — وخلطُهما كان أصل «التكرار».
 */
import { ClipboardList } from "lucide-react";
import { trpc } from "@/lib/trpc";
import ReceptionOrderQueue from "@/components/reception/ReceptionOrderQueue";
import StationPageHeader from "@/components/StationPageHeader";

export default function ReceptionOrdersPage() {
  const me = trpc.auth.me.useQuery();
  const branchId = me.data?.branchId != null ? Number(me.data.branchId) : null;
  const counts = trpc.workOrders.counts.useQuery(
    { branchId: branchId ?? 0, branchQueue: true },
    { enabled: branchId != null, staleTime: 30_000 },
  );

  return (
    <div className="mx-auto w-full max-w-[1180px] px-4 py-5">
      <StationPageHeader
        title="طلبات محطّتي"
        description="طابور التسليم والإسناد: ما صار جاهزاً بانتظار صاحبه، وما يُسنَد لمندوب أو شركة توصيل. مراحل التنفيذ نفسها في «لوحة الإنتاج»."
        Icon={ClipboardList}
        count={counts.data?.ready ?? 0}
        countLabel="جاهز بانتظار العميل"
      />
      {branchId == null ? <NoBranchNotice /> : <ReceptionOrderQueue branchId={branchId} />}
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
