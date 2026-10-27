#!/usr/bin/env node
// Production monitor for Kutt on Cloud Run, run every four hours by the scheduled
// `monitor_production` job. It answers two questions and fails the job if either is "no":
//
//   Monitor:   does the live service work? (the same five smoke probes used at deploy time)
//   Configure: is the live service exactly what was released and declared?
//              - 100% of traffic on one revision
//              - that revision runs the image digest the last approved deploy shipped
//              - its runtime settings match guardian/gcp/runtime-config.json
//
// A failed run fails the scheduled pipeline, which triggers the Omnis Guardian Duo flow
// (mode D): it diagnoses the failure and opens an incident issue for a person to act on.
//
// Usage: node guardian/ci/monitor.mjs --service svc.json --revision rev.json \
//          --deploy deploy-result.json --config guardian/gcp/runtime-config.json [--out monitor-result.json]
// Env:   KUTT_ADMIN_EMAIL, KUTT_ADMIN_PASSWORD (for the smoke probes)
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runSmoke } from './smoke.mjs';

const digestOf = (image) => (typeof image === 'string' && image.includes('@') ? image.slice(image.indexOf('@') + 1) : null);

// Kubernetes resource quantities have several spellings for one value ("1", "1000m", "1.0" CPU;
// "512Mi", "0.5Gi", "536870912" memory). Compare them as numbers, never as strings.
const SUFFIX = { m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 };
export function quantity(q) {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(m|k|M|G|T|Ki|Mi|Gi|Ti)?\s*$/.exec(String(q ?? ''));
  return m ? Number(m[1]) * (m[2] ? SUFFIX[m[2]] : 1) : null;
}

/**
 * Compare the live Cloud Run service and revision (Knative v1 JSON from
 * `gcloud run services/revisions describe --format=json`) with what was released and declared.
 * Returns one check per property; every check carries what was expected and what was found.
 */
export function checkRuntime({ service, revision, deploy, config }) {
  const checks = [];
  const add = (name, expected, actual, same = (a, b) => String(a) === String(b)) =>
    checks.push({ name, ok: actual != null && same(expected, actual), expected: String(expected), actual: actual == null ? 'missing' : String(actual) });
  const sameQuantity = (a, b) => quantity(a) !== null && Math.abs(quantity(a) - quantity(b)) < 1e-9 * Math.max(1, quantity(a));

  const traffic = (service?.status?.traffic ?? []).filter((t) => (t.percent ?? 0) > 0);
  const serving = traffic.length === 1 && traffic[0].percent === 100 ? traffic[0].revisionName : null;
  add('all traffic on one revision', 'yes', serving ? 'yes' : `${traffic.length} revisions serving`);
  add('serving revision is the one the revision data describes', serving ?? 'none', revision?.metadata?.name);

  const container = revision?.spec?.containers?.[0] ?? {};
  add('image digest is the last approved release', digestOf(deploy?.image) ?? 'unknown', digestOf(container.image));

  const ann = revision?.metadata?.annotations ?? {};
  add('container port', config.port, container.ports?.[0]?.containerPort);
  add('cpu', config.cpu, container.resources?.limits?.cpu, sameQuantity);
  add('memory', config.memory, container.resources?.limits?.memory, sameQuantity);
  add('min instances', config.minInstances, ann['autoscaling.knative.dev/minScale']);
  add('max instances', config.maxInstances, ann['autoscaling.knative.dev/maxScale']);
  for (const [name, ref] of Object.entries(config.secrets ?? {})) {
    const env = (container.env ?? []).find((e) => e.name === name);
    const key = env?.valueFrom?.secretKeyRef;
    add(`secret ${name}`, ref, key ? `${key.name}:${key.key}` : null);
  }
  for (const [k, v] of Object.entries(config.labels ?? {})) {
    add(`label ${k}`, v, service?.metadata?.labels?.[k]);
  }
  return { ok: checks.every((c) => c.ok), servingRevision: serving, checks };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
  const service = read(arg('--service'));
  const config = read(arg('--config', 'guardian/gcp/runtime-config.json'));
  const runtime = checkRuntime({ service, revision: read(arg('--revision')), deploy: read(arg('--deploy')), config });

  const { KUTT_ADMIN_EMAIL: email, KUTT_ADMIN_PASSWORD: password } = process.env;
  const url = service?.status?.url;
  const smoke = url && email && password ? await runSmoke({ url, email, password, attempts: 3 }) : { ok: false, probes: [], url };

  const result = { ok: runtime.ok && smoke.ok, url, checkedAt: new Date().toISOString(), runtime, smoke };
  writeFileSync(arg('--out', 'monitor-result.json'), JSON.stringify(result, null, 2) + '\n');

  console.log('Configure: live service against the release and guardian/gcp/runtime-config.json');
  for (const c of runtime.checks) console.log(`${c.ok ? 'PASS' : 'DRIFT'}  ${c.name}: expected ${c.expected}, found ${c.actual}`);
  console.log(`Monitor: live probes against ${url}`);
  for (const p of smoke.probes) console.log(`${p.ok ? 'PASS' : 'FAIL'}  ${p.name} (${p.ms} ms) ${p.detail ?? ''}`);
  if (!smoke.probes.length) console.log('FAIL  no probes ran (missing URL or admin credentials)');
  console.log(
    result.ok
      ? 'MONITOR PASSED: production is healthy and matches the approved release'
      : `MONITOR FAILED: ${[!runtime.ok && 'configuration drift', !smoke.ok && 'live probes failing'].filter(Boolean).join(' and ')}`
  );
  process.exitCode = result.ok ? 0 : 1;
}
