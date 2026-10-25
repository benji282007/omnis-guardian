#!/bin/sh
# Keyless Google Cloud login for CI: exchange the job's GitLab OIDC token (GCP_ID_TOKEN)
# for short-lived credentials through Workload Identity Federation. No stored keys.
# Sourced by deploy-cloudrun.sh and monitor-cloudrun.sh.
# Required: GCP_ID_TOKEN, GCP_WIF_PROVIDER, GCP_DEPLOYER_SA, GCP_PROJECT_ID, GCP_REGION
printf '%s' "$GCP_ID_TOKEN" > .gcp-oidc-token
gcloud iam workload-identity-pools create-cred-config "$GCP_WIF_PROVIDER" \
  --service-account="$GCP_DEPLOYER_SA" --credential-source-file=.gcp-oidc-token --output-file=.gcp-cred.json
gcloud auth login --cred-file=.gcp-cred.json --quiet
gcloud config set project "$GCP_PROJECT_ID" --quiet
gcloud config set run/region "$GCP_REGION" --quiet
