#!/bin/sh
# Deploy the approved, signed Kutt image to Cloud Run with a safety net:
#   1. authenticate to Google Cloud keylessly (GitLab OIDC → Workload Identity Federation)
#   2. copy the image BY DIGEST from the GitLab registry to Artifact Registry (digest unchanged)
#   3. deploy a new revision with NO traffic, tagged "c<pipeline iid>"
#   4. smoke-test the candidate on its tag URL; stop here if it fails (production untouched)
#   5. move 100% of traffic to the candidate, smoke-test production
#   6. if production fails, move traffic back to the previous revision (rollback)
# Writes deploy-result.json. Runs in the `deploy_production` job (google/cloud-sdk:slim).
#
# Required CI/CD variables: GCP_PROJECT_ID, GCP_REGION, GCP_WIF_PROVIDER, GCP_DEPLOYER_SA,
# GCP_RUNTIME_SA, and an id_token GCP_ID_TOKEN with aud https://iam.googleapis.com/$GCP_WIF_PROVIDER
set -eu
RUNTIME_CONFIG="guardian/gcp/runtime-config.json"
SERVICE="${CLOUD_RUN_SERVICE:-$(jq -r .service "$RUNTIME_CONFIG")}"
AR_REPO="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/kutt/kutt"
TAG="c${CI_PIPELINE_IID}"
SRC_REF="$(jq -r .imageRef dist/image.json)"
DIGEST="${SRC_REF#*@}"
result() { # status detail
  jq -n --arg status "$1" --arg detail "$2" --arg service "$SERVICE" --arg image "${AR_REPO}@${DIGEST}" \
    --arg url "${PROD_URL:-}" --arg candidate "${CANDIDATE_URL:-}" --arg revision "${NEW_REV:-}" --arg previous "${PREV_REV:-}" \
    '{status:$status, detail:$detail, service:$service, image:$image, url:$url, candidateUrl:$candidate, revision:$revision, previousRevision:$previous, at:(now|todate)}' \
    > deploy-result.json
  cat deploy-result.json
}

# 1. Keyless auth: exchange the GitLab OIDC token for short-lived Google credentials.
. guardian/ci/gcp-auth.sh

# 2. Copy by digest (crane keeps the manifest byte-for-byte, so the digest is identical).
CRANE_VERSION=v0.20.2
curl -sSfL -o crane.tgz "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"
curl -sSfL -o crane.sums "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/checksums.txt"
grep " go-containerregistry_Linux_x86_64.tar.gz\$" crane.sums | sed 's/go-containerregistry_Linux_x86_64.tar.gz/crane.tgz/' | sha256sum -c -
tar -xzf crane.tgz crane
./crane auth login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD"
gcloud auth print-access-token | ./crane auth login "${GCP_REGION}-docker.pkg.dev" -u oauth2accesstoken --password-stdin
./crane copy "$SRC_REF" "${AR_REPO}:${CI_COMMIT_SHA}"
COPIED="$(./crane digest "${AR_REPO}:${CI_COMMIT_SHA}")"
[ "$COPIED" = "$DIGEST" ] || { result failed "digest changed during copy ($COPIED != $DIGEST)"; exit 1; }
IMAGE="${AR_REPO}@${DIGEST}"

KUTT_ADMIN_PASSWORD="$(gcloud secrets versions access latest --secret=kutt-admin-password)"
export KUTT_ADMIN_PASSWORD KUTT_ADMIN_EMAIL="${KUTT_ADMIN_EMAIL:-admin@omnis-guardian.dev}"

# Runtime settings come from guardian/gcp/runtime-config.json (configuration as code);
# monitor_production checks the live service against the same file every four hours.
COMMON_FLAGS="$(jq -r --arg image "$IMAGE" --arg sa "$GCP_RUNTIME_SA" --arg commit "$CI_COMMIT_SHORT_SHA" '
  "--image=\($image) --service-account=\($sa) --port=\(.port) --cpu=\(.cpu) --memory=\(.memory)"
  + " --min-instances=\(.minInstances) --max-instances=\(.maxInstances)"
  + (if .allowUnauthenticated then " --allow-unauthenticated" else " --no-allow-unauthenticated" end)
  + " --set-secrets=" + ([.secrets | to_entries[] | "\(.key)=\(.value)"] | join(","))
  + " --labels=" + ([.labels | to_entries[] | "\(.key)=\(.value)"] + ["commit=\($commit)"] | join(","))
' "$RUNTIME_CONFIG")"

if ! gcloud run services describe "$SERVICE" --format='value(status.url)' >/dev/null 2>&1; then
  # First deploy: there is no previous revision to protect, so deploy directly.
  # shellcheck disable=SC2086
  gcloud run deploy "$SERVICE" $COMMON_FLAGS --quiet
  PROD_URL="$(gcloud run services describe "$SERVICE" --format='value(status.url)')"
  gcloud run services update "$SERVICE" --update-env-vars="DEFAULT_DOMAIN=${PROD_URL#https://},SITE_NAME=Kutt (Omnis Guardian demo)" --quiet
  NEW_REV="$(gcloud run services describe "$SERVICE" --format='value(status.latestReadyRevisionName)')"
  if node guardian/ci/smoke.mjs --url "$PROD_URL" --out smoke-production.json; then
    result deployed "first deployment; production smoke test passed"; exit 0
  fi
  result failed "first deployment failed its smoke test"; exit 1
fi

PROD_URL="$(gcloud run services describe "$SERVICE" --format='value(status.url)')"
PREV_REV="$(gcloud run services describe "$SERVICE" --format=json | jq -r '[.status.traffic[] | select(.percent == 100)][0].revisionName')"

# 3. Candidate revision with no traffic.
# shellcheck disable=SC2086
gcloud run deploy "$SERVICE" $COMMON_FLAGS --no-traffic --tag="$TAG" \
  --update-env-vars="DEFAULT_DOMAIN=${PROD_URL#https://},SITE_NAME=Kutt (Omnis Guardian demo)" --quiet
NEW_REV="$(gcloud run services describe "$SERVICE" --format='value(status.latestCreatedRevisionName)')"
CANDIDATE_URL="$(gcloud run services describe "$SERVICE" --format=json | jq -r --arg t "$TAG" '.status.traffic[] | select(.tag == $t) | .url')"

# 4. Smoke-test the candidate. Production still serves the previous revision.
if ! node guardian/ci/smoke.mjs --url "$CANDIDATE_URL" --out smoke-candidate.json; then
  result blocked "candidate $NEW_REV failed its smoke test; production still on $PREV_REV"
  exit 1
fi

# 5. Promote, then verify production.
gcloud run services update-traffic "$SERVICE" --to-revisions="${NEW_REV}=100" --quiet
if node guardian/ci/smoke.mjs --url "$PROD_URL" --out smoke-production.json; then
  result deployed "promoted $NEW_REV (previous: $PREV_REV)"
  exit 0
fi

# 6. Roll back.
gcloud run services update-traffic "$SERVICE" --to-revisions="${PREV_REV}=100" --quiet
result rolled_back "production smoke test failed on $NEW_REV; traffic returned to $PREV_REV"
exit 1
