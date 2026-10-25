#!/usr/bin/env node
// Find deploy-result.json from the newest successful deploy_production job on the default branch.
//
// Why not /jobs/artifacts/main/raw/deploy-result.json?job=deploy_production: that endpoint reads the
// latest *successful pipeline* on the ref, and an hourly scheduled monitor pipeline is one too (with no
// deploy job), so it would 404 from the second hour on. Instead walk recent push pipelines on the ref
// (release pipelines), find the deploy job, and read its artifact by job id.
//
// Usage: node guardian/ci/last-deploy.mjs --out deploy-result.json
// Env:   CI_API_V4_URL, CI_PROJECT_ID, CI_DEFAULT_BRANCH (all set in GitLab CI). Public project: no token.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function findLastDeploy({ apiUrl, projectId, ref, fetchImpl = fetch, pages = 3 }) {
  const api = (path) => `${apiUrl}/projects/${encodeURIComponent(projectId)}${path}`;
  const json = async (url) => {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  };
  for (let page = 1; page <= pages; page += 1) {
    const pipelines = await json(api(`/pipelines?ref=${encodeURIComponent(ref)}&source=push&per_page=20&page=${page}&order_by=id&sort=desc`));
    if (!pipelines.length) break;
    for (const p of pipelines) {
      const jobs = await json(api(`/pipelines/${p.id}/jobs?per_page=100`));
      const deploy = jobs.filter((j) => j.name === 'deploy_production' && j.status === 'success').sort((a, b) => b.id - a.id)[0];
      if (deploy) {
        const result = await json(api(`/jobs/${deploy.id}/artifacts/deploy-result.json`));
        return { result, job: { id: deploy.id, url: deploy.web_url }, pipeline: { id: p.id, iid: p.iid, url: p.web_url } };
      }
    }
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
  const { CI_API_V4_URL: apiUrl, CI_PROJECT_ID: projectId, CI_DEFAULT_BRANCH: ref = 'main' } = process.env;
  let found = null;
  try {
    found = await findLastDeploy({ apiUrl, projectId, ref });
  } catch (err) {
    console.log(`Could not read the last deploy: ${err.message}`);
  }
  // Always write a file, so monitor.mjs still runs and reports the digest as unknown (drift).
  writeFileSync(arg('--out', 'deploy-result.json'), JSON.stringify(found?.result ?? {}, null, 2) + '\n');
  console.log(found ? `Last approved deploy: job ${found.job.url} (pipeline #${found.pipeline.iid})` : 'No successful deploy_production job found');
}
