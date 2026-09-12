import { ControllerError } from "./errors.js";
/** Only explicit per-run overrides are stored; team frames and camera are derived. */
export class CanvasPositionStore {
    store;
    constructor(store) {
        this.store = store;
        store.db.exec(`create table if not exists canvas_positions (
      run_id text primary key references runs(run_id) on delete cascade,
      revision integer not null, positions_json text not null, updated_at text not null)`);
    }
    get(runId) {
        if (!this.store.getRun(runId))
            throw new ControllerError("Run not found.", "tool_error");
        const row = this.store.db.prepare("select * from canvas_positions where run_id=?").get(runId);
        const agents = new Set(this.store.listAgents({ runId, includeUnregistered: true }).map(agent => agent.agent_id));
        return { run_id: runId, revision: row?.revision ?? 0, coordinate_space: "run", updated_at: row?.updated_at ?? null,
            positions: row ? JSON.parse(row.positions_json).filter((point) => agents.has(point.agent_id)) : [] };
    }
    set(runId, expectedRevision, positions) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(positions) || !positions.length || positions.length > 1000)
            throw new ControllerError("Supply a current revision and 1–1000 agent positions.", "tool_error");
        return this.store.immediateTransaction(() => {
            const current = this.get(runId);
            if (current.revision !== expectedRevision)
                throw new ControllerError("Canvas changed. Read its current revision before moving nodes again.", "tool_error");
            const seen = new Set();
            for (const point of positions) {
                if (!point || typeof point.agent_id !== "string" || seen.has(point.agent_id) || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e6 || Math.abs(point.y) > 1e6 || this.store.getAgent(point.agent_id)?.run_id !== runId)
                    throw new ControllerError("Positions must be finite, unique and belong to this run.", "tool_error");
                seen.add(point.agent_id);
            }
            const points = new Map(current.positions.map(point => [point.agent_id, point]));
            for (const point of positions)
                points.set(point.agent_id, { agent_id: point.agent_id, x: point.x, y: point.y });
            const updatedAt = new Date().toISOString();
            this.store.db.prepare(`insert into canvas_positions values (?,?,?,?) on conflict(run_id) do update set
        revision=excluded.revision, positions_json=excluded.positions_json, updated_at=excluded.updated_at`)
                .run(runId, current.revision + 1, JSON.stringify([...points.values()]), updatedAt);
            return this.get(runId);
        });
    }
}
