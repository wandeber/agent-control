import BetterSqlite3 from "better-sqlite3";

/** Launchers prepare an ABI-specific addon; direct developer runs use their local install. */
class Database extends BetterSqlite3 {
  constructor(filename?: string | Buffer, options?: BetterSqlite3.Options) {
    super(filename, { ...(process.env.AGENT_CONTROL_SQLITE_BINDING
      ? { nativeBinding: process.env.AGENT_CONTROL_SQLITE_BINDING } : {}), ...options });
  }
}
namespace Database { export type Database = BetterSqlite3.Database; }
export default Database;
