import BetterSqlite3 from "better-sqlite3";
/** Launchers prepare an ABI-specific addon; direct developer runs use their local install. */
class Database extends BetterSqlite3 {
    constructor(filename, options) {
        super(filename, { ...(process.env.AGENT_CONTROL_SQLITE_BINDING
                ? { nativeBinding: process.env.AGENT_CONTROL_SQLITE_BINDING } : {}), ...options });
    }
}
export default Database;
