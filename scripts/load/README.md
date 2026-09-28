# Load tests

`api-smoke.js` drives the control plane with [k6](https://k6.io): dashboard-style reads,
cost previews, and a steady trickle of job creations with idempotency replays. It encodes the
latency and error-rate targets from `docs/09-observability-and-reliability.md`.

```bash
# local stack on mock providers (make up && make dev, or scripts/demo.sh services)
k6 run scripts/load/api-smoke.js

# against an environment, as a real user
k6 run -e API_URL=https://api.staging.example.com -e TOKEN="$CLERK_JWT" -e VUS=50 -e DURATION=5m scripts/load/api-smoke.js
```

What to watch while it runs:

- `avg_http_request_duration_seconds` and `avg_jobs_started_total` on the API's `/metrics`
- `avg_worker_workflow_task_execution_latency` and `avg_worker_worker_task_slots_available`
  on each worker's `:9464/metrics` (queue depth pressure shows up as slots at zero)
- Postgres connections and Temporal task queue backlog

Job creations are rate limited per plan and stop with `402 INSUFFICIENT_CREDITS` once the
workspace's balance is spent; both are expected outcomes and are counted in
`create_outcomes` rather than failing the run. Top up a dev workspace with the internal
credit-adjust endpoint (see `scripts/demo.sh`).

The pipeline itself is load tested separately by running the worker test suite's
`test_video_job_workflow_completes` under `pytest -n` with a high `SCENE_CONCURRENCY`, or by
submitting many demo jobs; the render stage is CPU-bound at roughly one core-minute per
minute of 1080p output.
