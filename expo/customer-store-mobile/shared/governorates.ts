export const governorates = [
  { id: "baghdad_amiriya", name: "بغداد - العامرية" }, { id: "baghdad", name: "بغداد" }, { id: "basra", name: "البصرة" }, { id: "nineveh", name: "نينوى (الموصل)" }, { id: "erbil", name: "أربيل" }, { id: "sulaymaniyah", name: "السليمانية" }, { id: "duhok", name: "دهوك" }, { id: "kirkuk", name: "كركوك" }, { id: "diyala", name: "ديالى (بعقوبة)" }, { id: "anbar", name: "الأنبار (الرمادي)" }, { id: "babil", name: "بابل (الحلة)" }, { id: "karbala", name: "كربلاء" }, { id: "najaf", name: "النجف" }, { id: "qadisiyah", name: "القادسية (الديوانية)" }, { id: "muthanna", name: "المثنى (السماوة)" }, { id: "dhiqar", name: "ذي قار (الناصرية)" }, { id: "maysan", name: "ميسان (العمارة)" }, { id: "wasit", name: "واسط (الكوت)" }, { id: "saladin", name: "صلاح الدين (تكريت)" },
] as const;

export function isBaghdadGovernorate(id: string | null | undefined): boolean {
  if (!id) return false;
  const trimmed = id.trim().toLowerCase();
  return (
    trimmed === "baghdad" ||
    trimmed === "baghdad_amiriya" ||
    trimmed.startsWith("baghdad_") ||
    trimmed.startsWith("baghdad-") ||
    trimmed === "بغداد" ||
    trimmed.startsWith("بغداد")
  );
}

