# What Omnis Guardian added to Kutt (Path B)

**Original project:** https://github.com/thedevs-network/kutt (MIT). Imported with full
history at upstream commit `029da42` (v3.2.6, 19 Oct 2026). Every commit after that one is
new work done for the hackathon, after 5 October 2026.

## New

| Area | Files |
|---|---|
| Duo Agent Platform flow (assisted plan → approve → fix) | `.gitlab/duo/flows/omnis-guardian.yml`, `AGENTS.md` |
| CI/CD pipeline (verify, secure, package, release, deploy) | `.gitlab-ci.yml` |
| Integration test suite (upstream Kutt has none) | `test/`, `test/helpers/kutt.js` |
| Security gate, Knex-aware Semgrep rules, npm audit report | `guardian/ci/security-gate.mjs`, `guardian/semgrep/rules.yml`, `guardian/ci/dependency-report.mjs` |
| Regression proof for fixes | `guardian/ci/regression-proof.mjs` |
| Image build, Sigstore signing, SLSA v1 attestation, verification | `guardian/ci/build-image.sh`, `provenance.mjs`, `verify-provenance.mjs`, `verify-signatures.sh` |
| Approver-checked release gate | `guardian/ci/release-gate.mjs` |
| Cloud Run deploy with candidate smoke and auto-rollback | `guardian/ci/deploy-cloudrun.sh`, `guardian/ci/smoke.mjs`, `guardian/gcp/bootstrap.sh` |
| SCI carbon report per pipeline | `guardian/ci/carbon-report.mjs` |
| Evidence dashboard (GitLab Pages) | `guardian/dashboard/` |
| Tests for all Guardian tooling | `guardian/test/`, `guardian/dashboard/test/` |

## Changed in Kutt itself

- `package.json`: added `test` and `test:guardian` scripts.
- On branch `guardian/dependency-upgrades`: `hbs` 4.2.1→4.4.0, `express` 4.22.2→4.22.3,
  `mysql2` 3.12.0→3.24.6, `nanoid` 3.3.8→3.3.20, `nodemailer` 9.0.3→10.2.1, plus lockfile
  updates, clearing all critical and high npm advisories. Kutt's application code is otherwise unchanged.

## Deployment

Kutt runs on **Google Cloud Run** (deployed by `deploy_production` after each approved
release). Live URL: *add after first deploy*.
