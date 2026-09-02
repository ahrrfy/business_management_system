import { Redirect } from "wouter";

/** رابط توافق فقط؛ مرتجع الشراء الجديد طلب صفري الأثر ثم اعتماد منفصل. */
export default function PurchaseReturnNew() {
  return <Redirect to="/purchases/returns-governance" />;
}
