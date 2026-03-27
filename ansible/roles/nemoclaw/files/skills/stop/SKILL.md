---
name: stop
description: Stop a running job
---

# Stop Job

## When to use

User wants to stop, cancel, kill, or abort a running task.

## API

DELETE http://yeet-01.tailnet:4646/v1/job/{job_id}?purge=false

The purge=false keeps the job in history so logs remain accessible.

## Confirmation

Always confirm which job you're stopping before executing. If ambiguous, list matching jobs first.
