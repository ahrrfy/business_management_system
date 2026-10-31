/** الشهر المدني الحالي في بغداد YYYY-MM، مستقلاً عن منطقة جهاز المستخدم وUTC. */
export function currentBaghdadMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Baghdad",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("تعذّر تحديد الشهر المدني في بغداد");
  return `${year}-${month}`;
}
