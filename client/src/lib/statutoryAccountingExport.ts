export type StatementDisplayRow = {
  key: string;
  section: string;
  version: string;
  code: string;
  name: string;
  amount: string;
  emphasis?: boolean;
};

type SourceRow = {
  profileId: number;
  profileVersion: number;
  accountId: number;
  code: string;
  name: string;
  amount: string;
};

type HashAccount = {
  code: string;
  name: string;
  type: string;
  normalBalance: string;
  parentId: number | null;
  isPosting: boolean;
  sortOrder: number;
};

type HashMapping = {
  internalCode: string;
  role: string | null;
  statutoryCode: string;
};

export type StatutoryHashMaterialRow = {
  profileId: number;
  profileKey: string;
  profileVersion: number;
  expectedHash: string;
  section: "ACCOUNT" | "MAPPING";
  sequence: number;
  canonicalJson: string;
};

/**
 * يحوّل حمولة الاعتماد إلى أجزاء JSON قصيرة وآمنة لخلايا Excel. تجميع الأجزاء
 * حسب `sequence` يعيد البايتات الأصلية حرفياً، بما فيها null وBoolean.
 */
export function buildStatutoryHashMaterial(details: Array<{
  profile: {
    id: number;
    profileKey: string;
    version: number;
    contentHash: string | null;
  };
  approvedAccounts: HashAccount[];
  approvedMappings: HashMapping[];
}>): StatutoryHashMaterialRow[] {
  return details.flatMap((detail) => {
    if (!detail.profile.contentHash) {
      throw new Error(`الدليل ${detail.profile.profileKey}/${detail.profile.version} بلا بصمة اعتماد.`);
    }
    const identity = {
      profileId: detail.profile.id,
      profileKey: detail.profile.profileKey,
      profileVersion: detail.profile.version,
      expectedHash: detail.profile.contentHash,
    };
    return [
      ...detail.approvedAccounts.map(
        ({ code, name, type, normalBalance, parentId, isPosting, sortOrder }, sequence) => ({
          ...identity,
          section: "ACCOUNT" as const,
          sequence,
          canonicalJson: JSON.stringify({ code, name, type, normalBalance, parentId, isPosting, sortOrder }),
        }),
      ),
      ...detail.approvedMappings.map(
        ({ internalCode, role, statutoryCode }, sequence) => ({
          ...identity,
          section: "MAPPING" as const,
          sequence,
          canonicalJson: JSON.stringify({ internalCode, role, statutoryCode }),
        }),
      ),
    ];
  });
}

export function reconstructStatutoryHashPayload(
  rows: StatutoryHashMaterialRow[],
  profileId: number,
): string {
  const parts = (section: StatutoryHashMaterialRow["section"]) => rows
    .filter((row) => row.profileId === profileId && row.section === section)
    .sort((left, right) => left.sequence - right.sequence)
    .map((row) => row.canonicalJson)
    .join(",");
  return `{"accounts":[${parts("ACCOUNT")}],"mappings":[${parts("MAPPING")}]}`;
}

export function requireCompleteStatutoryExport<T>(
  report: { rows: T[]; export: { complete: boolean; rowLimit: number } },
  entityLabel: string,
): T[] {
  if (!report.export.complete) {
    throw new Error(
      `${entityLabel} يتجاوز ${report.export.rowLimit.toLocaleString("en-US")} سطر؛ قسّم الفترة ثم أعد التصدير.`,
    );
  }
  return report.rows;
}

export function buildBalanceStatementRows(report: {
  assets: SourceRow[];
  liabilities: SourceRow[];
  equity: SourceRow[];
  totals: {
    assets: string;
    liabilities: string;
    equity: string;
    unclosedResult: string;
    liabilitiesAndEquity: string;
    difference: string;
  };
}): StatementDisplayRow[] {
  return [
    ...report.assets.map((row) => ({ key: `asset-${row.profileId}-${row.accountId}`, section: "الأصول", version: String(row.profileVersion), code: row.code, name: row.name, amount: row.amount })),
    { key: "assets-total", section: "الإجمالي", version: "—", code: "", name: "إجمالي الأصول", amount: report.totals.assets, emphasis: true },
    ...report.liabilities.map((row) => ({ key: `liability-${row.profileId}-${row.accountId}`, section: "الالتزامات", version: String(row.profileVersion), code: row.code, name: row.name, amount: row.amount })),
    { key: "liabilities-total", section: "الإجمالي", version: "—", code: "", name: "إجمالي الالتزامات", amount: report.totals.liabilities, emphasis: true },
    ...report.equity.map((row) => ({ key: `equity-${row.profileId}-${row.accountId}`, section: "حقوق الملكية", version: String(row.profileVersion), code: row.code, name: row.name, amount: row.amount })),
    { key: "equity-total", section: "الإجمالي", version: "—", code: "", name: "إجمالي حقوق الملكية", amount: report.totals.equity, emphasis: true },
    { key: "unclosed-result", section: "النتيجة", version: "—", code: "", name: "نتيجة النشاط غير المقفلة", amount: report.totals.unclosedResult, emphasis: true },
    { key: "liabilities-equity-total", section: "الإجمالي", version: "—", code: "", name: "الالتزامات وحقوق الملكية", amount: report.totals.liabilitiesAndEquity, emphasis: true },
    { key: "equation-difference", section: "فحص", version: "—", code: "", name: "فرق المعادلة", amount: report.totals.difference, emphasis: true },
  ];
}

export function buildIncomeStatementRows(report: {
  revenues: SourceRow[];
  expenses: SourceRow[];
  totals: { revenue: string; expenses: string; netIncome: string };
}): StatementDisplayRow[] {
  return [
    ...report.revenues.map((row) => ({ key: `revenue-${row.profileId}-${row.accountId}`, section: "الإيرادات", version: String(row.profileVersion), code: row.code, name: row.name, amount: row.amount })),
    { key: "revenue-total", section: "الإجمالي", version: "—", code: "", name: "إجمالي الإيرادات", amount: report.totals.revenue, emphasis: true },
    ...report.expenses.map((row) => ({ key: `expense-${row.profileId}-${row.accountId}`, section: "المصروفات", version: String(row.profileVersion), code: row.code, name: row.name, amount: row.amount })),
    { key: "expense-total", section: "الإجمالي", version: "—", code: "", name: "إجمالي المصروفات", amount: report.totals.expenses, emphasis: true },
    { key: "net-income", section: "النتيجة", version: "—", code: "", name: "صافي نتيجة النشاط", amount: report.totals.netIncome, emphasis: true },
  ];
}
