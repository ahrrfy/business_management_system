const bidi = (value: string) => `\u2068${value}\u2069`;

function roundedInteger(value: number | string): bigint {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value))) {
      throw new Error("قيمة المبلغ غير صالحة للعرض.");
    }
    return BigInt(Math.round(value));
  }

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error("قيمة المبلغ غير صالحة للعرض.");
  const [, sign, whole, fraction = ""] = match;
  let result = BigInt(whole);
  if (fraction[0] && fraction[0] >= "5") result += 1n;
  return sign === "-" ? -result : result;
}

/** Formats trusted decimal strings without first converting them to a JS number. */
export function formatIqd(amount: number | string): string {
  const integer = roundedInteger(amount);
  const negative = integer < 0n;
  const digits = (negative ? -integer : integer).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${bidi(`${negative ? "-" : ""}${grouped}`)} د.ع`;
}

export function formatBaghdadTime(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ar-IQ-u-nu-latn", {
    timeZone: "Asia/Baghdad",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
