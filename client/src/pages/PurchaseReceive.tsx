import { Redirect, useParams } from "wouter";

/** رابط توافق فقط؛ الاستلام الجديد حصراً عبر إذن GRN مستقلّ ومحكوم. */
export default function PurchaseReceive() {
  const params = useParams();
  const purchaseOrderId = Number(params.id);
  const query = Number.isSafeInteger(purchaseOrderId) && purchaseOrderId > 0
    ? `?purchaseOrderId=${purchaseOrderId}`
    : "";
  return <Redirect to={`/purchases/goods-receipts${query}`} />;
}
