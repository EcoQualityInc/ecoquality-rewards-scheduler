# EcoQuality Rewards Scheduler

Dependency-free background transport for the private EcoQuality Rewards service.
This repository contains no storefront source, customer records, credentials,
discount codes, or database connection settings.

## Safety

- Disabled unless the repository Actions variable `REWARDS_SCHEDULER_ENABLED` is `true`.
- Runs only from `main` in this exact repository, on the standard Ubuntu runner.
- No pull-request triggers, package installation, artifact uploads, or caches.
- The worker key is an Actions secret, supplied only to the dispatch step.
- Requests are bounded, serial, pinned to the storefront origin, and never follow redirects.
- Public logs report success/failure only. Customer information and queue counters are not printed.
- The private server enforces its own authentication, feature flags, leases, and idempotency.
- Pause by setting `REWARDS_SCHEDULER_ENABLED=false`; also pause server flags during an incident.

## Private Configuration

Repository Actions variables: `REWARDS_SCHEDULER_OWNER`,
`REWARDS_SCHEDULER_QUEUES`, and `REWARDS_SCHEDULER_ENABLED`.
The worker key belongs only in the `REWARDS_SCHEDULER_WORKER_SECRET` Actions secret.
Never put keys or customer information in issues, commits, variables, or logs.

The private storefront repository's scheduler must remain disabled to prevent
duplicate scheduling. Running this transport is not proof that customer Rewards
is enabled or that queued messages reached an inbox.

Standard GitHub-hosted runners are free for public repositories, subject to
[GitHub's current Actions limits](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Schedules may be delayed or disabled after repository inactivity; the operator
must monitor recent successful runs and maintain the schedule. No timing SLA is promised.
