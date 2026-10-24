#!/bin/sh
# Verify, against the registry, that the image is signed by this project's
# default-branch pipeline and carries a signed SLSA provenance attestation whose
# predicate matches dist/provenance.intoto.json. Writes dist/signature-result.json.
# Never exits non-zero: the release gate decides what a failed check means.
set -u
apk add --no-cache cosign jq >/dev/null
IMAGE_REF="$(jq -r .imageRef dist/image.json)"
IDENTITY="${CI_PROJECT_URL}//.gitlab-ci.yml@refs/heads/${CI_DEFAULT_BRANCH}"
echo "$CI_REGISTRY_PASSWORD" | cosign login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" --password-stdin >/dev/null 2>&1

sig=false; att=false; match=false; detail=""
if cosign verify "$IMAGE_REF" --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$CI_SERVER_URL" >/dev/null 2>dist/verify.log; then
  sig=true
else
  detail="image signature did not verify"
fi
if cosign verify-attestation "$IMAGE_REF" --type slsaprovenance1 \
     --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$CI_SERVER_URL" > dist/attestation.jsonl 2>>dist/verify.log; then
  att=true
  # The attested predicate must be the one this pipeline generated.
  # cosign re-encodes SLSA v1's "invocationId" as "invocationID", so compare with
  # object keys lower-cased. Any difference in a value still fails the check.
  NORM='walk(if type == "object" then with_entries(.key |= ascii_downcase) else . end)'
  attested="$(head -1 dist/attestation.jsonl | jq -r .payload | base64 -d | jq -S ".predicate | $NORM")"
  expected="$(jq -S ".predicate | $NORM" dist/provenance.intoto.json)"
  [ "$attested" = "$expected" ] && match=true || detail="${detail:+$detail; }attested provenance differs from this pipeline's"
else
  detail="${detail:+$detail; }provenance attestation did not verify"
fi

verified=false
[ "$sig" = true ] && [ "$att" = true ] && [ "$match" = true ] && verified=true
jq -n --argjson verified "$verified" --argjson signature "$sig" --argjson attestation "$att" --argjson predicateMatches "$match" \
  --arg identity "$IDENTITY" --arg issuer "$CI_SERVER_URL" --arg image "$IMAGE_REF" \
  --arg detail "${detail:-signature and provenance attestation verified}" \
  '{verified: $verified, signature: $signature, attestation: $attestation, predicateMatches: $predicateMatches, identity: $identity, issuer: $issuer, image: $image, detail: $detail}' \
  > dist/signature-result.json
cat dist/signature-result.json
