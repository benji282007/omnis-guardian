# Devpost submission (copy into the form)

**Project name:** Omnis Guardian

**Tagline:** An assisted release guardian for real open-source apps: GitLab Duo diagnoses and fixes, CI proves the fix, and a person approves the plan, the merge and the release.

**Path:** B (Bring Your Own) · **Autonomy level:** Assisted · **Special prize:** Most Stages Covered (Path B)

**Links**
- Repository: https://gitlab.com/omnis-guardian1/omnis-guardian
- Original MIT project: https://github.com/thedevs-network/kutt
- Deployed project (Google Cloud Run): https://kutt-bda5naktma-uc.a.run.app
- Evidence dashboard: https://omnis-guardian-af8ca1.gitlab.io
- What changed (Path B): https://gitlab.com/omnis-guardian1/omnis-guardian/-/blob/main/guardian/docs/WHAT-CHANGED.md
- Video: [YouTube link]

---

## In 20 seconds

A GitLab Duo flow investigates failures in a real open-source app and proposes a fix, then waits.
A maintainer approves. CI decides whether the fix is real: the new test must fail on the old code and
pass on the fix. A person releases, Cloud Run deploys a tested candidate, and a scheduled monitor keeps
checking production. When we changed production by hand, it caught the drift and Duo opened an
incident with the fix, which a person applied. Every step below links to the real run.

| GitLab DevSecOps stage | What runs | Evidence |
|---|---|---|
| Plan | Duo flow posts a diagnosis and plan on the MR, or an incident for production | [MR !4 plan](https://gitlab.com/omnis-guardian1/omnis-guardian/-/merge_requests/4) · [incident #1](https://gitlab.com/omnis-guardian1/omnis-guardian/-/work_items/1) |
| Create | After approval, the flow opens a fix MR with a regression test | [MR !6](https://gitlab.com/omnis-guardian1/omnis-guardian/-/merge_requests/6) |
| Verify | Integration tests, and regression proof against the old code and the fix | [PROVEN](https://gitlab.com/omnis-guardian1/omnis-guardian/-/jobs/17445549698) |
| Secure | Semgrep (Knex-aware rules), Secret Detection, npm audit, fail-closed gate | [feature blocked](https://gitlab.com/omnis-guardian1/omnis-guardian/-/pipelines/2985030830) |
| Package | Image built, booted and smoke-tested; signed with SLSA provenance | [pipeline #96](https://gitlab.com/omnis-guardian1/omnis-guardian/-/pipelines/2986648931) |
| Release | A person starts the approver-checked `release_gate` | [release_gate](https://gitlab.com/omnis-guardian1/omnis-guardian/-/jobs/17449104756) |
| Configure | Runtime settings as code, drift-checked every four hours | [DRIFT caught](https://gitlab.com/omnis-guardian1/omnis-guardian/-/jobs/17448852788) |
| Monitor | Canary deploy, promote, auto-rollback; scheduled live probes | [candidate → promoted](https://gitlab.com/omnis-guardian1/omnis-guardian/-/jobs/17449104758) |
| Govern | Signatures and provenance re-verified before release; SCI carbon per pipeline | [provenance docs](https://gitlab.com/omnis-guardian1/omnis-guardian/-/blob/main/guardian/docs/PROVENANCE.md) |

**What is new.** Most "AI fixes CI" demos treat the agent's patch as the result. Here the agent's
output is only a proposal: a person approves the plan, and CI must prove the fix by running the new
test against the old code too, which is how it rejected the agent's own first test before a revision
passed. The same boundary holds after release: the agent diagnoses production incidents and
recommends the fix, and a person applies it.

## Inspiration

Code generation is fast now. What still stalls a release is everything after it: a security
finding nobody has time to read, a fix nobody can prove, a release nobody can vouch for. Most
"self-healing" demos hand all of that to an agent. We wanted the opposite for a real project with
real users: let the agent do the investigation, keep a person on every decision, and make CI, not
the agent, the judge.

**Who it's for:** maintainers of small open-source and self-hosted projects, a handful of
volunteers with no security team and no release engineer. AI tools now write code faster than these
teams can check it is safe to ship.

**Before and after (Path B):** upstream Kutt v3.2.6 had three GitHub Actions workflows that build
and push a Docker image, no tests, no security scanning, and shipped with 3 critical and 5 high npm
advisories. On GitLab with Omnis Guardian it has 16 CI jobs across merge request, release and scheduled monitor pipelines, 19 integration and regression
tests, three scanners behind a fail-closed gate, a Duo flow that diagnoses and fixes on approval,
proof that every Duo fix's regression test fails on the old code and passes on the fix, signed releases a person approves, and a Cloud Run deploy with candidate
testing and automatic rollback. The full table is in the README.

## What it does

Omnis Guardian wraps **Kutt**, a self-hosted URL shortener with about 10k GitHub stars, in a GitLab
workflow where a person approves the plan, the merge and the release, and acts on every incident;
CI and the canary deploy run automatically between those decisions.

1. **Detect.** Every merge request runs Kutt's integration tests and three scanners: Semgrep with
   Knex-aware rules, GitLab Secret Detection and npm audit. A fail-closed `security_gate` blocks
   critical and high findings.
2. **Plan, then wait.** When a merge request's security or test check fails (or the scheduled
   production monitor fails, see step 7), GitLab triggers our **Duo Agent Platform flow**. It
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
7. **Watch production.** Every four hours a scheduled pipeline re-runs the live probes and checks for
   configuration drift: Cloud Run must serve the last approved digest with exactly the settings in
   `runtime-config.json`. A failure triggers the same Duo flow, which reads the logs and opens an
   **incident issue** with a diagnosis and a recommended action. It never touches production; a
   person acts, and the next scheduled check confirms the fix.
8. **Ask before you ship.** A read-only **custom Duo agent**, the Release Assistant, is created and
   enabled in the project for Duo Chat. It is built to answer "is this safe to ship?" on a merge
   request or incident from the gate results and job logs, and to name the decision that is still
   the maintainer's. Our group's Duo credits ran out before we recorded a chat session with it, so
   unlike everything else here it has no public run to link.
9. **Show the evidence.** A Pages dashboard summarizes all nine GitLab stages, each linked to the
   pipeline, job or merge request behind it, plus a per-pipeline SCI carbon figure. Every value comes
   from a real run; the only seeded input is the risky feature in MR !4, which exists to be caught.

**It caught real problems on day one.** The first pipeline on unmodified upstream Kutt v3.2.6 was
blocked with **3 critical and 5 high** npm advisories. The upgrade cleared all of them, and every
Kutt test still passed. Two moderate advisories remain (`uuid` through Bull); the only fix is a
Bull downgrade, so they stay reported in the pipeline rather than hidden.

## Sustainability (modelled, CI runner time only)

Figures from `guardian/ci/carbon-report.mjs` (Green Software Foundation SCI, `(E × I + M)` per
pipeline; CCF coefficients, assumptions listed in the report), applied to recorded job durations:

| Pipeline | Jobs | Runner time | Estimated SCI |
|---|---:|---:|---:|
| Full release ([guardian-96](https://gitlab.com/omnis-guardian1/omnis-guardian/-/pipelines/2986648931)) | 14 | 387 s | 0.68 gCO₂e |
| Merge request (no image build or release) | 7–10 | 157–251 s | 0.27–0.44 gCO₂e |
| Scheduled production check (`monitor_production` only) | 1 | 66 s | 0.11 gCO₂e (mean of 12 runs) |

Two design choices keep the recurring cost small. The production check runs one job instead of the
full pipeline, about 84% less per check. It runs every four hours rather than every two, which
halves monitoring to about 0.23 kgCO₂e a year. The boundary is GitLab hosted-runner CI only:
Duo inference, Cloud Run runtime and networking are outside it. These are modelled estimates, not
metered measurements, and we claim no emissions reduction beyond these design choices.

## How we built it

- **GitLab Duo Agent Platform:** a custom flow (flow registry v1) with a planner and an executor
  agent and four modes (plan, approve, revise, incident triage), plus a read-only custom agent for
  Duo Chat, all using only GitLab API tools. The flow is triggered by *Pipeline events → Failed* and *Mention*,
  and runs under composite identity. GitLab Duo Code Review reviewed every merge request.
- **GitLab CI/CD:** 16 jobs across verify, secure, package, release and deploy, running on hosted
  runners. Also used: the Secret Detection template, the release keyword, Pages, protected
  variables, `id_tokens` for Sigstore and for Google Cloud, and dotenv artifacts.
- **Google Cloud:** Cloud Run, Artifact Registry, Secret Manager, and Workload Identity Federation
  with no service-account keys.
- **Supply chain:** cosign keyless signing and attestation (entries in the public Rekor log), SLSA
  v1 provenance built from the registry digest, verified again before release.
- **Kutt:** imported with full upstream history. We added an integration test suite (upstream has
  none), dependency upgrades, and `engines`. Everything else is in `guardian/`.
- 19 Kutt integration and regression tests, and 55 tests for the Guardian tooling.

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
  All three are fixed. The access check now refuses on any error except one: if the flow's token
  cannot read membership (HTTP 403 `insufficient_scope`), it relies on GitLab's composite identity,
  which still blocks anyone below Developer from creating branches or commits.
- GitLab rejects prompts that contain HTML comments, so `config_check` now checks for that before
  a flow ever reaches GitLab.

## Accomplishments we're proud of

- A complete loop on a real, popular app: detect → plan → approve → fix → prove → release → deploy.
- A real drift drill: someone changed production by hand, the scheduled monitor caught it, Duo opened
  an incident with the exact fix, a person applied it through the approved deploy, and the next check
  passed. Duo never touched production
  ([incident #1](https://gitlab.com/omnis-guardian1/omnis-guardian/-/work_items/1)).
- Every result on the dashboard and in the README links to a real pipeline, merge request, job or release.
- Keyless end to end: no stored cloud keys, no signing keys.

## What we learned

The agent is most useful when it is not the last word. Asking it for a plan first, approving the
plan, and making CI prove the result turned out more reliable than letting it act alone.

## What's next

Upstream the dependency upgrades and the integration test suite to Kutt, and point the flow at
other open-source projects (the rules and prompts are not Kutt-specific).

## Built with

gitlab-duo-agent-platform · gitlab-ci · google-cloud-run · artifact-registry · workload-identity-federation · secret-manager · sigstore · cosign · slsa · semgrep · node.js · express · knex · sqlite
