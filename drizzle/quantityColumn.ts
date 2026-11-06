import { customType } from "drizzle-orm/mysql-core";
import { quantityNumber, toDbQuantity } from "../shared/quantity";

/** DECIMAL storage with the existing exact numeric application/read contract. */
export const quantityColumn = customType<{ data: number; driverData: string }>({
  dataType: () => "decimal(15,4)",
  toDriver: (value) => toDbQuantity(value),
  fromDriver: (value) => quantityNumber(value),
});
