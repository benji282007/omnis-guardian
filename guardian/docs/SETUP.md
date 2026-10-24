# Setup

About 45 minutes the first time. You need: a GitLab namespace with Duo Agent Platform
(the hackathon-provisioned group, or an Ultimate trial group), Maintainer/Owner on the
project, and a Google Cloud project with billing.

## 1. Push the project

1. Create a new **public** project in that namespace (no README).
2. From the folder you got from Claude:
   ```bash
   git clone omnis-guardian-kutt.bundle omnis-guardian && cd omnis-guardian
   git remote remove origin 2>/dev/null; git remote add origin https://gitlab.com/<namespace>/<project>.git
   git push -u origin main
   ```
   Sign in normally when git asks. Don't put a token in the URL.
3. The first pipeline runs on upstream Kutt's dependencies and **should be blocked by
   `security_gate`** (3 critical, 5 high npm advisories). That is real, expected, and the
   first piece of evidence. Then push the fix branch and open its MR:
   ```bash
   git push -u origin guardian/dependency-upgrades -o merge_request.create -o merge_request.target=main \
     -o merge_request.title="Upgrade dependencies flagged by the Guardian dependency gate"
   ```
   Merge it once its pipeline passes.

## 2. CI/CD variables

**Settings → CI/CD → Variables**, all *protected*:

| Key | Value |
|---|---|
| `RELEASE_APPROVERS` | your GitLab username (comma-separate several) |
| `RELEASE_REQUIRE_FOUR_EYES` | `false` only if you are the sole maintainer |
| `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `GCP_RUNTIME_SA` | printed by step 3 |

Make sure `main` is a protected branch (it is by default); Google Cloud only trusts
tokens from protected `main`.

## 3. Google Cloud (keyless)

Open **Google Cloud Shell**, upload `guardian/gcp/bootstrap.sh`, and run:
```bash
bash bootstrap.sh <gcp-project-id> <gitlab-namespace>/<project> us-central1
```
It creates an Artifact Registry repo, two service accounts, two secrets, and a Workload
Identity Federation provider that trusts **only this project's protected `main`**. No keys
are created. Copy the printed variables into GitLab (step 2).

The Kutt admin password for the live instance:
`gcloud secrets versions access latest --secret=kutt-admin-password` (email `admin@omnis-guardian.dev`).

## 4. The Duo flow

1. **AI → Flows → New flow.** Name `Omnis Guardian`, description
   `Assisted remediation: diagnoses failed MR pipelines, posts a plan, implements it when a maintainer approves.`
   Configuration **Flow**; paste all of `.gitlab/duo/flows/omnis-guardian.yml`; **Create flow**.
2. Open it and **Enable** it for the project. GitLab creates a service account
   (`ai-<flow>-<group>`) with Developer access. Note its username and, if it is not
   `ai-omnis-guardian-omnis-guardian`, set it as the `guardian_account` literal input in the
   flow YAML (top of the `planner` component), then save the flow again.
3. **AI → Triggers → New flow trigger**: add condition **Pipeline events → Failed**, then
   add condition **Mention**; pick the service account; source = this flow; **Create**.

## 5. Run the demo

```bash
sh guardian/demo/start-incident.sh
```
Then follow [DEMO.md](DEMO.md). On `main`, start `release_gate` to approve a release;
`deploy_production` then deploys to Cloud Run.

## Troubleshooting

- **Flow never starts:** check the trigger is on, the session list under AI, and your GitLab Credits balance.
- **`build_image` can't reach Docker:** hosted runners support `docker:dind`; check the job isn't on a custom runner.
- **`deploy_production` auth error:** the project path in `bootstrap.sh` must match exactly, and the pipeline must be on protected `main`.
- **`verify_signatures` fails:** signing only happens on `main`; re-run the `main` pipeline.
