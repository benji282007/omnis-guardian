#!/usr/bin/env node
// Build an in-toto v1 Statement with an SLSA Provenance v1 predicate for the
// Kutt container image built in this pipeline. The subject is the image digest
// reported by the registry push; the source is the git commit (recorded as
// `gitCommit`); the base image is recorded with its resolved digest.
//
// In CI, the statement is then signed and attached to the image with
// `cosign attest --type slsaprovenance1` (see guardian/ci/build-image.sh).
//
// Usage: node guardian/ci/provenance.mjs --image-info dist/image.json --out dist/provenance.intoto.json
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';

/** Split "registry/repo@sha256:abc" into { name, sha256 }. */
export function parseDigestRef(ref) {
  const match = /^(.+)@sha256:([0-9a-f]{64})$/.exec(ref ?? '');
  if (!match) throw new Error(`not a digest reference: ${ref}`);
  return { name: match[1], sha256: match[2] };
}

/**
 * @param {{ imageInfo: { imageRef: string, baseImageRef?: string|null, commit: string, dockerfile?: string },
 *           env?: Record<string, string|undefined>, now?: Date }} opts
 */
export function buildStatement({ imageInfo, env = process.env, now = new Date() }) {
  const { name, sha256 } = parseDigestRef(imageInfo.imageRef);
  if (!/^[0-9a-f]{40}$/.test(imageInfo.commit ?? '')) throw new Error(`invalid commit ${imageInfo.commit}`);
  const inCi = env.CI === 'true' && Boolean(env.CI_PROJECT_URL);
  const projectUrl = inCi ? env.CI_PROJECT_URL : 'local';

  const resolvedDependencies = [{ uri: inCi ? `git+${projectUrl}.git` : 'local', digest: { gitCommit: imageInfo.commit } }];
  if (imageInfo.baseImageRef) {
    const base = parseDigestRef(imageInfo.baseImageRef);
    resolvedDependencies.push({ uri: `docker://${base.name}`, digest: { sha256: base.sha256 } });
  }

  return {
    _type: STATEMENT_TYPE,
    subject: [{ name, digest: { sha256 } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: inCi
          ? `${projectUrl}/-/blob/${imageInfo.commit}/docs/PROVENANCE.md#buildtype-docker-build-v1`
          : 'local:docs/PROVENANCE.md#buildtype-docker-build-v1',
        externalParameters: {
          source: inCi ? `git+${projectUrl}.git@${env.CI_COMMIT_REF_NAME}` : 'local working copy',
          dockerfile: imageInfo.dockerfile ?? 'Dockerfile',
          ciConfigPath: env.CI_CONFIG_PATH ?? '.gitlab-ci.yml',
          pipelineSource: env.CI_PIPELINE_SOURCE ?? null
        },
        internalParameters: {},
        resolvedDependencies
      },
      runDetails: {
        builder: {
          id: inCi ? `${env.CI_SERVER_URL}/${env.CI_PROJECT_PATH}/-/runners/${env.CI_RUNNER_ID ?? 'unknown'}` : 'local-developer-machine',
          version: inCi ? { 'gitlab-runner': env.CI_RUNNER_VERSION ?? 'unknown' } : {}
        },
        metadata: {
          invocationId: inCi ? env.CI_JOB_URL : 'local',
          startedOn: env.CI_JOB_STARTED_AT ?? null,
          finishedOn: now.toISOString()
        },
        byproducts: inCi ? [{ name: 'pipeline', uri: env.CI_PIPELINE_URL }] : []
      }
    }
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const imageInfo = JSON.parse(readFileSync(arg('--image-info', 'dist/image.json'), 'utf8'));
  const statement = buildStatement({ imageInfo });
  const out = arg('--out', 'dist/provenance.intoto.json');
  writeFileSync(out, JSON.stringify(statement, null, 2) + '\n');
  // cosign attest takes the predicate alone.
  writeFileSync(out.replace(/\.intoto\.json$/, '.predicate.json'), JSON.stringify(statement.predicate, null, 2) + '\n');
  console.log(`Wrote ${out}`);
  console.log(`subject ${statement.subject[0].name}@sha256:${statement.subject[0].digest.sha256}`);
  console.log(`source commit ${imageInfo.commit}`);
}
