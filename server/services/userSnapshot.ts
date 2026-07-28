import { eq } from "drizzle-orm";
import { users } from "../../drizzle/schema";
import type { Tx } from "../db";

/** اسم المستخدم وقت تنفيذ المستند — لقطة ثابتة للتدقيق التاريخي. */
export async function userNameSnapshot(tx: Tx, userId: number): Promise<string | null> {
  const row = (
    await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0];
  return row?.name?.trim() || null;
}
