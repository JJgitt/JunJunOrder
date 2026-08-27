import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Database = ReturnType<typeof drizzle<typeof schema>>;

const globalDatabase = globalThis as typeof globalThis & {
  junjunSql?: ReturnType<typeof postgres>;
  junjunDb?: Database;
};

export function getDb(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 未配置");
  if (!globalDatabase.junjunSql) {
    globalDatabase.junjunSql = postgres(url, {
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  globalDatabase.junjunDb ??= drizzle(globalDatabase.junjunSql, { schema });
  return globalDatabase.junjunDb;
}
