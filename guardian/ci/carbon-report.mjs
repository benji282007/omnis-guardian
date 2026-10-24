#!/usr/bin/env node
// Software Carbon Intensity (SCI) of this pipeline, following the Green Software
// Foundation formula  SCI = (E × I + M) per R,  with R = one pipeline run.
//
// E comes from the measured duration of every finished job in this pipeline (GitLab
// API) and the hosted runner's machine size; coefficients follow the Cloud Carbon
// Footprint (CCF) methodology. Every coefficient is listed in the report with its
// source or marked as an assumption, and can be overridden with an env variable.
//
// Boundary: CI jobs on GitLab hosted runners. Out of boundary (not measurable from
// GitLab): LLM inference for Duo flows, the Cloud Run service at runtime, networking.
//
// Usage: node guardian/ci/carbon-report.mjs [--out carbon-report.json] [--jobs-json file]
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export function coefficients(env = process.env) {
  return {
    cpuMinWattsPerVcpu: { value: num(env.CARBON_CPU_MIN_W, 1.34), source: 'CCF methodology: GCP average min watts per vCPU' },
    cpuMaxWattsPerVcpu: { value: num(env.CARBON_CPU_MAX_W, 4.98), source: 'CCF methodology: GCP average max watts per vCPU' },
    cpuUtilization: { value: num(env.CARBON_CPU_UTILIZATION, 0.5), source: 'CCF default when utilization is unknown (assumption)' },
    memoryWattsPerGb: { value: num(env.CARBON_MEMORY_W_PER_GB, 0.392), source: 'CCF methodology: 0.000392 kWh per GB-hour' },
    pue: { value: num(env.CARBON_PUE, 1.1), source: 'CCF methodology: GCP PUE' },
    gridGramsPerKwh: { value: num(env.CARBON_GRID_G_PER_KWH, 500), source: 'CCF: us-east1 0.0005 tCO2e/kWh (Google); GitLab hosted runners run in us-east1/us-east5' },
    embodiedKgPerHost: { value: num(env.CARBON_EMBODIED_KG_PER_HOST, 1200), source: 'assumption: order-of-magnitude server LCA; adjust with CARBON_EMBODIED_KG_PER_HOST' },
    hostVcpus: { value: num(env.CARBON_HOST_VCPUS, 64), source: 'assumption: vCPUs per physical host' },
    hostLifetimeYears: { value: num(env.CARBON_HOST_LIFETIME_YEARS, 4), source: 'CCF / Teads: 4-year expected lifespan' }
  };
}

// GitLab.com hosted Linux runners (docs.gitlab.com/ci/runners/hosted_runners/linux/).
const MACHINES = {
  'saas-linux-small-amd64': { vcpus: 2, memoryGb: 8 },
  'saas-linux-medium-amd64': { vcpus: 4, memoryGb: 16 },
  'saas-linux-large-amd64': { vcpus: 8, memoryGb: 32 },
  'saas-linux-xlarge-amd64': { vcpus: 16, memoryGb: 64 },
  'saas-linux-2xlarge-amd64': { vcpus: 32, memoryGb: 128 },
  'saas-linux-small-arm64': { vcpus: 2, memoryGb: 8 },
  'saas-linux-medium-arm64': { vcpus: 4, memoryGb: 16 },
  'saas-linux-large-arm64': { vcpus: 8, memoryGb: 32 }
};

export function machineFor(job) {
  const tag = (job.tag_list ?? []).find((t) => MACHINES[t]);
  return { tag: tag ?? 'saas-linux-small-amd64', ...(MACHINES[tag] ?? MACHINES['saas-linux-small-amd64']) };
}

/** Energy (kWh), operational (g), embodied (g) for one job. */
export function jobCarbon(job, c) {
  const hours = (job.duration ?? 0) / 3600;
  const m = machineFor(job);
  const cpuWatts = c.cpuMinWattsPerVcpu.value + c.cpuUtilization.value * (c.cpuMaxWattsPerVcpu.value - c.cpuMinWattsPerVcpu.value);
  const watts = m.vcpus * cpuWatts + m.memoryGb * c.memoryWattsPerGb.value;
  const kwh = (watts * hours * c.pue.value) / 1000;
  const operationalG = kwh * c.gridGramsPerKwh.value;
  // CCF: M = TE × (time reserved / lifetime) × (resources reserved / total resources)
  const lifetimeHours = c.hostLifetimeYears.value * 365 * 24;
  const embodiedG = c.embodiedKgPerHost.value * 1000 * (hours / lifetimeHours) * (m.vcpus / c.hostVcpus.value);
  return { name: job.name, stage: job.stage, status: job.status, seconds: Math.round(job.duration ?? 0), machine: m.tag, kwh, operationalG, embodiedG };
}

export function buildReport(jobs, { env = process.env, now = new Date() } = {}) {
  const c = coefficients(env);
  const finished = jobs.filter((j) => typeof j.duration === 'number' && j.duration > 0 && j.finished_at);
  const perJob = finished.map((j) => jobCarbon(j, c));
  const sum = (k) => perJob.reduce((a, j) => a + j[k], 0);
  const E = sum('kwh');
  const O = sum('operationalG');
  const M = sum('embodiedG');
  return {
    method: 'SCI = (E × I + M) per R (Green Software Foundation); energy per CCF methodology',
    functionalUnit: 'one pipeline run',
    boundary: {
      included: 'finished CI jobs of this pipeline on GitLab hosted runners (including service containers on the same VM)',
      excluded: 'LLM inference for Duo flows, Cloud Run runtime, network transfer, jobs still running when measured'
    },
    pipeline: env.CI_PIPELINE_URL ?? null,
    commit: env.CI_COMMIT_SHA ?? null,
    jobsMeasured: perJob.length,
    runnerSeconds: Math.round(perJob.reduce((a, j) => a + j.seconds, 0)),
    energyKwh: E,
    operationalGrams: O,
    embodiedGrams: M,
    sciGramsPerPipeline: O + M,
    coefficients: c,
    jobs: perJob.map((j) => ({ ...j, kwh: +j.kwh.toFixed(6), operationalG: +j.operationalG.toFixed(3), embodiedG: +j.embodiedG.toFixed(3) })),
    measuredAt: now.toISOString()
  };
}

async function fetchJobs(env) {
  const url = `${env.CI_API_V4_URL}/projects/${env.CI_PROJECT_ID}/pipelines/${env.CI_PIPELINE_ID}/jobs?per_page=100&include_retried=true`;
  // Public projects allow unauthenticated reads; otherwise set CARBON_API_TOKEN (read_api).
  const headers = env.CARBON_API_TOKEN ? { 'PRIVATE-TOKEN': env.CARBON_API_TOKEN } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitLab API ${res.status} listing pipeline jobs`);
  return res.json();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const input = arg('--jobs-json');
  const jobs = input ? JSON.parse(readFileSync(input, 'utf8')) : await fetchJobs(process.env);
  const report = buildReport(jobs);
  writeFileSync(arg('--out', 'carbon-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Measured ${report.jobsMeasured} jobs, ${report.runnerSeconds} runner-seconds`);
  console.log(`E = ${report.energyKwh.toFixed(5)} kWh, O = ${report.operationalGrams.toFixed(2)} g, M = ${report.embodiedGrams.toFixed(2)} g`);
  console.log(`SCI = ${report.sciGramsPerPipeline.toFixed(2)} gCO2e per pipeline run`);
}
