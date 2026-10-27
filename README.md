# EcoQuality Rewards Scheduler

Dependency-free health monitoring for the private EcoQuality Rewards service.
Production business processing runs in the private Supabase scheduler. This
repository checks health independently and does not advance business work while
`REWARDS_SCHEDULER_ENABLED=false`.
This repository contains no storefront source, customer records, credentials,
discount codes, or database connection settings.

## Safety

- The read-only monitor runs when `REWARDS_SCHEDULER_ENABLED=false`.
- The financial dispatch job has been removed from this workflow. Supabase alone processes business jobs.
- A stale financial-enable flag fails the monitor instead of silently skipping its check.
- Runs only from `main` in this exact repository, on the standard Ubuntu runner.
- No pull-request triggers, package installation, artifact uploads, or caches.
- The worker key is an Actions secret, supplied only to the selected worker step.
- Requests are bounded, serial, pinned to the storefront origin, and never follow redirects.
- Public logs report success/failure only. Customer information and queue counters are not printed.
- The private server enforces its own authentication, feature flags, leases, and idempotency.
- Pause business processing in the private Supabase scheduler and server flags during an incident.

## Private Configuration

Repository Actions variables: `REWARDS_SCHEDULER_OWNER`,
`REWARDS_SCHEDULER_QUEUES`, and `REWARDS_SCHEDULER_ENABLED`.
The worker key belongs only in the `REWARDS_SCHEDULER_WORKER_SECRET` Actions secret.
Never put keys or customer information in issues, commits, variables, or logs.

Both GitHub financial dispatchers must remain disabled to prevent duplicate
scheduling. A health check does not prove that queued messages reached an inbox.
An initial backlog or a staff review can cause a failed health check; inspect the
private Rewards administration instead of retrying financial jobs blindly.

Standard GitHub-hosted runners are free for public repositories, subject to
[GitHub's current Actions limits](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Schedules may be delayed or disabled after repository inactivity; the operator
must monitor recent successful runs and maintain the schedule. No timing SLA is promised.
