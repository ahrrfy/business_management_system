import { allowedQueries as cashQueries } from "../cash/schema-queries";
import { creditQueries } from "./queries-extra";
// Original-service shapes only; tests must expose every new supported SQL path.
export const allowedQueries = new Set([...cashQueries, ...creditQueries]);
