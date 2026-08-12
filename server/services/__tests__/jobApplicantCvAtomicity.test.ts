import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import { createApplicant } from "../recruitmentService";

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set for tests");
  return database;
}

beforeEach(async () => {
  await db().insert(schema.branches).values({ id: 1, name: "CV branch", code: "CV-BR" });
});

describe("job applicant CV atomicity", () => {
  it("creates applicant, random public pointer and binary row together", async () => {
    const pdf = Buffer.from("%PDF-1.7\n%%EOF");
    const applicant = await createApplicant({
      name: "CV candidate",
      branchId: 1,
      cv: { fileName: "candidate.pdf", mimeType: "application/pdf", base64: pdf.toString("base64") },
    });
    expect(applicant?.cvFileKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await db()
      .select()
      .from(schema.jobApplicantCvFiles)
      .where(eq(schema.jobApplicantCvFiles.applicantId, applicant!.id));
    expect(stored?.publicKey).toBe(applicant?.cvFileKey);
    expect(stored?.bytes.equals(pdf)).toBe(true);
  });

  it("leaves no orphan blob when the applicant insert fails", async () => {
    const before = await db().select({ id: schema.jobApplicantCvFiles.id }).from(schema.jobApplicantCvFiles);
    await expect(createApplicant({
      // MySQL strict mode rejects this before the CV insert can run.
      name: "x".repeat(201),
      branchId: 1,
      cv: {
        fileName: "candidate.pdf",
        mimeType: "application/pdf",
        base64: Buffer.from("%PDF-1.7").toString("base64"),
      },
    })).rejects.toThrow();
    const after = await db().select({ id: schema.jobApplicantCvFiles.id }).from(schema.jobApplicantCvFiles);
    expect(after).toHaveLength(before.length);
  });
});
