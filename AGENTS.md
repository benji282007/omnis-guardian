# Instructions for AI agents working in this repository

This repository is **Kutt** (an open-source URL shortener, MIT, upstream
github.com/thedevs-network/kutt) wrapped with **Omnis Guardian**, an assisted
DevSecOps workflow built on GitLab Duo Agent Platform and GitLab CI/CD.

## Layout

| Path | What it is |
|---|---|
| `server/` | Kutt application code (Node.js 22, Express, Knex; SQLite by default). |
| `test/` | Integration tests (`node:test`) that boot a real Kutt. Helpers in `test/helpers/kutt.js`. |
| `test/regression/` | Regression tests added with fixes. |
| `guardian/` | Omnis Guardian tooling: CI scripts, Semgrep rules, dashboard, GCP setup. |
| `.gitlab/duo/flows/` | The Duo flow definition. |
| `.gitlab/duo/agents/` | The read-only Release Assistant custom agent (Duo Chat). |
| `guardian/gcp/runtime-config.json` | Cloud Run runtime settings; deploys apply it, the hourly monitor checks for drift. |

## Commands

- Kutt tests: `npm test` (needs `npm ci` first)
- Guardian tests: `npm run test:guardian`

## Rules for changes

1. Fix defects in `server/` with the smallest change that works. Do not refactor.
2. Prefer Knex query-builder methods over raw SQL. When an identifier (column, direction)
   comes from a request, check it against an allow-list. Pass values as bindings.
3. Every fix to `server/` needs a regression test in `test/regression/` that fails on the old
   code (with an assertion, using benign invalid input) and passes on the fix. CI enforces
   this with the `regression_proof` job.
4. Never modify or delete existing tests, `guardian/`, `.gitlab-ci.yml` or `.gitlab/` to make
   a pipeline pass. Never lower severity thresholds.
5. Never commit secrets, tokens or credentials.
6. Agents never merge, approve, release or deploy. People approve every step.
