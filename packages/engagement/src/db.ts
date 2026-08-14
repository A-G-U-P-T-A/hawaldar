import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { applySchema } from "./migrate.js";
import * as schema from "./schema.js";

export type HawaldarDatabase = BetterSQLite3Database<typeof schema>;

export interface Persistence {
  readonly db: HawaldarDatabase;
  readonly sqlite: Database.Database;
  close(): void;
}

export function openDatabase(databasePath: string): Persistence {
  mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  applySchema(sqlite);
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    close() {
      sqlite.close();
    },
  };
}
