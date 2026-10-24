# Build provenance

`build_image` builds Kutt's image from the commit and pushes it to the GitLab container
registry. It records the digest the registry returned in `dist/image.json` and writes an
in-toto Statement v1 with an SLSA Provenance v1 predicate to `dist/provenance.intoto.json`.

On `main`, the same job keyless-signs the image (`cosign sign`) and attaches the predicate
as a signed attestation (`cosign attest --type slsaprovenance1`), using the job's GitLab
OIDC token (`aud: sigstore`). Building and signing in one job means the image can't change
in between.

`verify_signatures` checks, against the registry, that the signature and the attestation
were made by `<project URL>//.gitlab-ci.yml@refs/heads/main`. It also checks that the
attested predicate matches this pipeline's statement. `release_gate` blocks the release
unless that and `verify-provenance.mjs` (digest and commit match) both pass.

`deploy_production` copies the image to Artifact Registry by digest and checks the digest
is unchanged after the copy. Cloud Run then runs exactly the image that was signed.

## buildType: docker-build v1

- **externalParameters**: `source` (repo@ref), `dockerfile`, `ciConfigPath`, `pipelineSource`
- **resolvedDependencies**: the repository by `gitCommit`; the base image by digest
- **runDetails.builder.id**: `<GitLab URL>/<project>/-/runners/<runner id>`; `invocationId` is the job URL

## Verify a release yourself

```bash
IMAGE=registry.gitlab.com/<namespace>/<project>/kutt@sha256:<digest>
ID="https://gitlab.com/<namespace>/<project>//.gitlab-ci.yml@refs/heads/main"
cosign verify "$IMAGE" --certificate-identity "$ID" --certificate-oidc-issuer https://gitlab.com
cosign verify-attestation "$IMAGE" --type slsaprovenance1 --certificate-identity "$ID" --certificate-oidc-issuer https://gitlab.com
```

## Limits

The statement is produced by this project's CI scripts and then signed; that is strong
evidence of *which pipeline* built the image, not a SLSA Build L3 platform guarantee.
