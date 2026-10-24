#!/bin/sh
# Build Kutt's container image from the commit, push it to the GitLab container
# registry, and record its digest. On the default branch, also keyless-sign the
# image and attach the SLSA provenance as a signed attestation (Sigstore, GitLab
# OIDC token in SIGSTORE_ID_TOKEN). Runs in the `build_image` job (docker:dind).
set -eu
mkdir -p dist
apk add --no-cache nodejs git cosign >/dev/null
git config --global --add safe.directory "$CI_PROJECT_DIR"

echo "$CI_REGISTRY_PASSWORD" | docker login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" --password-stdin

BASE_IMAGE="$(sed -n 's/^FROM \([^ ]*\).*/\1/p' Dockerfile | head -1)"
docker pull -q "$BASE_IMAGE" >/dev/null
BASE_REF="$(docker inspect --format '{{index .RepoDigests 0}}' "$BASE_IMAGE")"

TAG="$CI_REGISTRY_IMAGE/kutt:$CI_COMMIT_SHA"
docker build \
  --label "org.opencontainers.image.source=$CI_PROJECT_URL" \
  --label "org.opencontainers.image.revision=$CI_COMMIT_SHA" \
  --label "org.opencontainers.image.licenses=MIT" \
  -t "$TAG" .
docker push -q "$TAG" >/dev/null
IMAGE_REF="$(docker inspect --format '{{index .RepoDigests 0}}' "$TAG")"
SIZE="$(docker image inspect --format '{{.Size}}' "$TAG")"

cat > dist/image.json <<EOF
{"imageRef": "$IMAGE_REF", "tag": "$TAG", "baseImageRef": "$BASE_REF", "commit": "$CI_COMMIT_SHA", "dockerfile": "Dockerfile", "sizeBytes": $SIZE}
EOF
echo "IMAGE_REF=$IMAGE_REF" > image.env
echo "Built and pushed $IMAGE_REF"

node guardian/ci/provenance.mjs --image-info dist/image.json --out dist/provenance.intoto.json
node guardian/ci/verify-provenance.mjs --dist dist --expect-commit "$CI_COMMIT_SHA"

if [ "${CI_COMMIT_BRANCH:-}" = "$CI_DEFAULT_BRANCH" ]; then
  export COSIGN_YES=true
  cosign sign "$IMAGE_REF"
  cosign attest --type slsaprovenance1 --predicate dist/provenance.predicate.json "$IMAGE_REF"
  echo "Signed $IMAGE_REF and attached its SLSA provenance attestation"
else
  echo "Not the default branch: image is not signed."
fi
