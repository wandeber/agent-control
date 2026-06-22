# Worker Launch Smoke

This prompt is used by `agentctl smoke worker-launch`.

The smoke worker is a manual Agent Control participant. It does not contact
external backends, does not modify project repositories, and exists only to
validate worker registration, launch, terminal event recording, detached watcher
completion, and cleanup.
