# Devpost submission (copy into the form)

**Project name:** Omnis Guardian

**Tagline:** An assisted release guardian for real open-source apps: GitLab Duo diagnoses and fixes, CI proves the fix, and a person approves every step.

**Path:** B (Bring Your Own) · **Autonomy level:** Assisted · **Special prize:** Most Stages Covered (Path B)

**Links**
- Repository: https://gitlab.com/omnis-guardian1/omnis-guardian
- Original MIT project: https://github.com/thedevs-network/kutt
- Deployed project (Google Cloud Run): https://kutt-bda5naktma-uc.a.run.app
- Evidence dashboard: https://omnis-guardian-af8ca1.gitlab.io
- What changed (Path B): https://gitlab.com/omnis-guardian1/omnis-guardian/-/blob/main/guardian/docs/WHAT-CHANGED.md
- Video: [YouTube link]

---

## Inspiration

Code generation is fast now. What still stalls a release is everything after it: a security
finding nobody has time to read, a fix nobody can prove, a release nobody can vouch for. Most
"self-healing" demos hand all of that to an agent. We wanted the opposite for a real project with
real users: let the agent do the investigation, keep a person on every decision, and make CI, not
the agent, the judge.

## What it does

Omnis Guardian wraps **Kutt**, a self-hosted URL shortener with about 10k GitHub stars, in a GitLab
workflow where a person approves every step.

1. **Detect.** Every merge request runs Kutt's integration tests and three scanners: Semgrep with
   Knex-aware rules, GitLab Secret Detection and npm audit. A fail-closed `security_gate` blocks
   critical and high findings.
2. **Plan, then wait.** When a pipeline fails, GitLab triggers our **Duo Agent Platform flow**. It
   reads the failed job logs and the code, posts a diagnosis and fix plan on the merge request, and
   stops.
3. **Approve.** A maintainer replies `@ai-omnis-guardian-omnis-guardian approve`. The flow checks
   who approved and opens a `guardian/fix-*` merge request with a minimal fix and a regression test.
4. **Prove.** `regression_proof` runs the new test against the old code (it must fail with an
   assertion) and against the fix (it must pass). If CI rejects the agent's work, the maintainer can
   reply `revise`, and the flow reads the CI failures and pushes a corrected commit.
5. **Release.** On `main`, the image is built, booted and smoke-tested, then signed with **Sigstore
   keyless signing** along with a signed **SLSA v1 provenance attestation** for its exact digest. A
   person starts `release_gate`, which checks they are an allowed approver and re-verifies the
   signatures against the registry.
6. **Deploy safely.** The signed image is copied **by digest** to Artifact Registry and deployed to
   **Cloud Run**: a no-traffic candidate is smoke-tested, promoted, re-checked, and rolled back
   automatically if production fails. Google Cloud access is keyless (GitLab OIDC → Workload
   Identity Federation, trusted only for this project's protected `main`).
7. **Show the evidence.** A Pages dashboard shows every stage from live GitLab data and the
   pipeline's own artifacts, plus a per-pipeline SCI carbon figure. Nothing on it is simulated.

**It caught real problems on day one.** The first pipeline on unmodified upstream Kutt v3.2.6 was
blocked with **3 critical and 5 high** npm advisories. The upgrade cleared all of them, and every
Kutt test still passed.

## How we built it

- **GitLab Duo Agent Platform:** a custom flow (flow registry v1) with a planner and an executor
  agent, using only GitLab API tools. It is triggered by *Pipeline events → Failed* and *Mention*,
  and runs under composite identity. GitLab Duo Code Review reviewed every merge request.
- **GitLab CI/CD:** 15 jobs across verify, secure, package, release and deploy, running on hosted
  runners. Also used: the Secret Detection template, the release keyword, Pages, protected
  variables, `id_tokens` for Sigstore and for Google Cloud, and dotenv artifacts.
- **Google Cloud:** Cloud Run, Artifact Registry, Secret Manager, and Workload Identity Federation
  with no service-account keys.
- **Supply chain:** cosign keyless signing and attestation (entries in the public Rekor log), SLSA
  v1 provenance built from the registry digest, verified again before release.
- **Kutt:** imported with full upstream history. We added an integration test suite (upstream has
  none), dependency upgrades, and `engines`. Everything else is in `guardian/`.
- 19 Kutt integration and regression tests, and 38 tests for the Guardian tooling.

## Challenges we ran into

- **The agent's first test was wrong, and CI caught it.** Duo's fix removed the injection, but its
  regression test sorted Kutt's UUID link ids numerically and failed on its own fix. That is why the
  workflow never trusts the agent, and why we added the approved `revise` step. After a `revise`,
  Duo rewrote only the test, and `regression_proof` printed **PROVEN**: the new assertions fail on
  the old code and pass on the fix.
- **Duo's code review held the feature to a higher bar than its tests did.** After the injection
  fix, GitLab Duo Code Review still blocked the merge until sorting had a stable tiebreaker and a
  test that checks real ordering. We fixed both, and Duo approved.
- **The gates caught our own mistakes too.** The first signed release failed our strict provenance
  comparison because cosign re-encodes one SLSA field name, so the gate refused to call it verified
  until we fixed the comparison.
- **GitLab Duo Code Review made the flow safer.** It found that a forged plan comment could have
  been approved, that the revise path could touch CI files, and that an access check failed open.
  All three are fixed.
- GitLab rejects prompts that contain HTML comments, so `config_check` now checks for that before
  a flow ever reaches GitLab.

## Accomplishments we're proud of

- A complete loop on a real, popular app: detect → plan → approve → fix → prove → release → deploy.
- Every claim on the dashboard and in this text links to a real pipeline, merge request or log.
- Keyless end to end: no stored cloud keys, no signing keys.

## What we learned

The agent is most useful when it is not the last word. Asking it for a plan first, approving the
plan, and making CI prove the result turned out more reliable than letting it act alone.

## What's next

Upstream the dependency upgrades and the integration test suite to Kutt, and point the flow at
other open-source projects (the rules and prompts are not Kutt-specific).

## Built with

gitlab-duo-agent-platform · gitlab-ci · google-cloud-run · artifact-registry · workload-identity-federation · secret-manager · sigstore · cosign · slsa · semgrep · node.js · express · knex · sqlite
