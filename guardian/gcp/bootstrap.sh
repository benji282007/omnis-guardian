#!/bin/bash
# One-time Google Cloud setup for Omnis Guardian. Run in Google Cloud Shell:
#
#   bash bootstrap.sh <gcp-project-id> <gitlab-project-path> [region]
#   e.g. bash bootstrap.sh my-project fl4sh28/omnis-guardian us-central1
#
# Creates (idempotently):
#   - Artifact Registry repo "kutt"
#   - service accounts kutt-runtime (runs Kutt) and kutt-deployer (used by CI)
#   - secrets kutt-jwt-secret and kutt-admin-password (random values)
#   - Workload Identity Federation pool "gitlab" + provider "gitlab-com" that trusts
#     ONLY tokens from <gitlab-project-path> on the protected "main" branch
# No keys are created or downloaded. Prints the GitLab CI/CD variables to set.
set -euo pipefail
PROJECT_ID="${1:?gcp project id}"
GITLAB_PATH="${2:?gitlab project path, e.g. group/project}"
REGION="${3:-us-central1}"

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

echo "Enabling APIs…"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com

echo "Artifact Registry…"
gcloud artifacts repositories describe kutt --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create kutt --repository-format=docker --location="$REGION" \
    --description="Kutt images promoted by Omnis Guardian"

echo "Service accounts…"
for sa in kutt-runtime kutt-deployer; do
  gcloud iam service-accounts describe "$sa@$PROJECT_ID.iam.gserviceaccount.com" >/dev/null 2>&1 || \
    gcloud iam service-accounts create "$sa" --display-name="$sa (Omnis Guardian)"
done
RUNTIME_SA="kutt-runtime@$PROJECT_ID.iam.gserviceaccount.com"
DEPLOYER_SA="kutt-deployer@$PROJECT_ID.iam.gserviceaccount.com"

echo "Secrets…"
for s in kutt-jwt-secret kutt-admin-password; do
  if ! gcloud secrets describe "$s" >/dev/null 2>&1; then
    openssl rand -base64 36 | tr -d '\n' | gcloud secrets create "$s" --replication-policy=automatic --data-file=-
  fi
done
gcloud secrets add-iam-policy-binding kutt-jwt-secret --member="serviceAccount:$RUNTIME_SA" \
  --role=roles/secretmanager.secretAccessor >/dev/null
# The deployer reads the admin password only to run smoke tests after deploying.
gcloud secrets add-iam-policy-binding kutt-admin-password --member="serviceAccount:$DEPLOYER_SA" \
  --role=roles/secretmanager.secretAccessor >/dev/null

echo "Deployer permissions (least privilege)…"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOYER_SA" --role=roles/run.admin --condition=None >/dev/null
gcloud artifacts repositories add-iam-policy-binding kutt --location="$REGION" \
  --member="serviceAccount:$DEPLOYER_SA" --role=roles/artifactregistry.writer >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$DEPLOYER_SA" --role=roles/iam.serviceAccountUser >/dev/null

echo "Workload Identity Federation (trusts $GITLAB_PATH @ protected main only)…"
gcloud iam workload-identity-pools describe gitlab --location=global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create gitlab --location=global --display-name="GitLab"
WIF_MAPPING="google.subject=assertion.sub,attribute.project_path=assertion.project_path,attribute.ref=assertion.ref,attribute.ref_protected=assertion.ref_protected"
WIF_CONDITION="assertion.project_path == '${GITLAB_PATH}' && assertion.ref == 'main' && assertion.ref_protected == 'true'"
# On a rerun, update the provider too, so the trust condition always matches $GITLAB_PATH.
if gcloud iam workload-identity-pools providers describe gitlab-com --location=global --workload-identity-pool=gitlab >/dev/null 2>&1; then
  WIF_VERB=update-oidc
else
  WIF_VERB=create-oidc
fi
gcloud iam workload-identity-pools providers "$WIF_VERB" gitlab-com \
  --location=global --workload-identity-pool=gitlab \
  --issuer-uri="https://gitlab.com" \
  --attribute-mapping="$WIF_MAPPING" \
  --attribute-condition="$WIF_CONDITION"
PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/gitlab/providers/gitlab-com"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/gitlab/attribute.project_path/${GITLAB_PATH}" >/dev/null

cat <<EOF

Done. Add these CI/CD variables in GitLab (Settings → CI/CD → Variables), as *protected*:

  GCP_PROJECT_ID    = ${PROJECT_ID}
  GCP_REGION        = ${REGION}
  GCP_WIF_PROVIDER  = ${PROVIDER}
  GCP_DEPLOYER_SA   = ${DEPLOYER_SA}
  GCP_RUNTIME_SA    = ${RUNTIME_SA}

No keys were created. The Kutt admin password is in Secret Manager (kutt-admin-password):
  gcloud secrets versions access latest --secret=kutt-admin-password
EOF
