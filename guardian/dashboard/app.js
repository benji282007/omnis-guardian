// Omnis Guardian dashboard. Reads config.json + evidence.json (written by the
// `pages` CI job) and live data from the public GitLab REST API. All text is
// inserted with textContent; nothing is rendered from untrusted HTML.
import {
  mapStages,
  releaseGateState,
  isGuardianMr,
  summariseGuardianMr,
  toneFor,
  shortSha,
  formatAgo,
  summariseMonitorRuns,
  summariseMonitorResult,
  summariseIncident,
  incidentStory
} from './model.js';

const REFRESH_MS = 120_000; // polite to GitLab's anonymous API limits; paused while the tab is hidden
const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const dot = (tone) => h('span', { class: `dot dot-${tone}`, 'aria-hidden': 'true' });
const link = (href, text, cls) => (href ? h('a', { href, target: '_blank', rel: 'noopener', class: cls }, text) : h('span', { class: cls }, text));

async function getJson(url, { timeoutMs = 10_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${new URL(url, location.href).pathname}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
const tryJson = (url) => getJson(url).catch(() => null);

function api(config, path) {
  return `${config.apiUrl}/projects/${encodeURIComponent(config.projectId)}${path}`;
}

async function loadLive(config) {
  // Release pipelines only: scheduled monitor runs are shown in Monitor/Configure, not here.
  const pipelines = await getJson(api(config, `/pipelines?ref=${encodeURIComponent(config.defaultBranch)}&source=push&per_page=8&order_by=id&sort=desc`));
  const latest = pipelines[0] ?? null;
  const jobs = latest ? await getJson(api(config, `/pipelines/${latest.id}/jobs?per_page=100&include_retried=true`)) : [];

  const mrs = (await getJson(api(config, '/merge_requests?state=all&per_page=40&order_by=created_at&sort=desc'))).filter(isGuardianMr).slice(0, 4);
  const guardian = await Promise.all(
    mrs.map(async (mr) => {
      const mrPipelines = (await tryJson(api(config, `/merge_requests/${mr.iid}/pipelines?per_page=1`))) ?? [];
      const mrJobs = mrPipelines[0] ? (await tryJson(api(config, `/pipelines/${mrPipelines[0].id}/jobs?per_page=100&include_retried=true`))) ?? [] : [];
      const proofJob = mrJobs.filter((j) => j.name === 'regression_proof').sort((a, b) => b.id - a.id)[0];
      const proof = proofJob ? await tryJson(api(config, `/jobs/${proofJob.id}/artifacts/regression-proof.json`)) : null;
      return { mr, summary: summariseGuardianMr(mr, mrJobs, proof), pipeline: mrPipelines[0] ?? null };
    })
  );
  const releases = (await tryJson(api(config, '/releases?per_page=5'))) ?? [];
  // The newest successful deploy, read by job id: "latest artifact on main" would resolve to an
  // scheduled monitor pipeline, which has no deploy job.
  let deploy = null;
  for (const p of pipelines) {
    const pJobs = p.id === latest?.id ? jobs : (await tryJson(api(config, `/pipelines/${p.id}/jobs?per_page=100`))) ?? [];
    const job = pJobs.filter((j) => j.name === 'deploy_production' && j.status === 'success').sort((a, b) => b.id - a.id)[0];
    if (job) {
      deploy = await tryJson(api(config, `/jobs/${job.id}/artifacts/deploy-result.json`));
      break;
    }
  }
  // null (not []) when the call fails, so the panel says "unavailable" rather than a clean state it never checked.
  const monitorRuns = await tryJson(api(config, `/pipelines?ref=${encodeURIComponent(config.defaultBranch)}&source=schedule&per_page=12&order_by=id&sort=desc`));
  const monitorPipeline = monitorRuns?.[0] ?? null;
  const monitorJobs = monitorPipeline ? ((await tryJson(api(config, `/pipelines/${monitorPipeline.id}/jobs?per_page=20`))) ?? []).filter((j) => j.name === 'monitor_production') : [];
  const monitor = monitorJobs[0] ? await tryJson(api(config, `/jobs/${monitorJobs[0].id}/artifacts/monitor-result.json`)) : null;
  const rawIncidents = await tryJson(api(config, '/issues?labels=incident&state=all&per_page=5&order_by=created_at&sort=desc'));
  const incidents = rawIncidents ? rawIncidents.map((i) => summariseIncident(i, config.guardianAccount)) : null;
  // The scheduled runs around the newest incident, so its story survives as newer runs arrive.
  let storyRuns = [];
  if (incidents?.[0]?.openedAt) {
    const from = new Date(Date.parse(incidents[0].openedAt) - 3 * 3600_000).toISOString();
    const to = new Date(Date.parse(incidents[0].closedAt ?? new Date().toISOString()) + 3 * 3600_000).toISOString();
    storyRuns = (await tryJson(api(config, `/pipelines?ref=${encodeURIComponent(config.defaultBranch)}&source=schedule&updated_after=${from}&updated_before=${to}&per_page=40`))) ?? [];
  }
  return { pipelines, latest, jobs, guardian, releases, deploy, monitorPipeline, monitorJobs, monitor, monitorRuns, incidents, storyRuns };
}

/* ---------------------------------------------------------------- render */

function renderHeader(config, live, error) {
  $('project-name').textContent = config?.projectPath ?? 'not configured';
  if (config?.projectUrl) $('project-link').href = config.projectUrl;
  const tone = error ? 'fail' : live ? 'pass' : 'idle';
  $('freshness').replaceChildren(dot(tone), h('span', {}, error ? 'Live data unavailable' : live ? `Live · ${new Date().toLocaleTimeString()}` : 'Snapshot only'));
}

function renderNotice(text) {
  const n = $('notice');
  n.hidden = !text;
  n.textContent = text ?? '';
}

function renderGate(config, live, evidence) {
  const gate = releaseGateState(live?.jobs ?? []);
  const section = $('gate');
  section.dataset.state = gate.state;
  const pipe = live?.latest;
  $('gate-pipeline').textContent = pipe ? `pipeline #${pipe.iid ?? pipe.id} on ${pipe.ref}` : 'no pipeline data';

  const copy = {
    awaiting: ['Release awaiting approval', 'All automated checks for this commit have run. A person on the approver list must start the release_gate job in GitLab; the gate then re-verifies the evidence and records who approved.'],
    approved: [gate.label, `Approved by ${gate.approver ?? 'unknown'} ${formatAgo(gate.approvedAt)}. The approval and the evidence it checked are stored in release-evidence.json.`],
    blocked: ['Release blocked', `The gate rejected the release${gate.approver ? ` started by ${gate.approver}` : ''}. Open the job log to see which check failed.`],
    running: ['Release gate running', 'The gate is checking approver, evidence and provenance.'],
    waiting: ['Waiting for checks', 'The release gate becomes available after tests, security and packaging pass.'],
    'not-run': [gate.label, live ? 'Release gates only exist on default-branch pipelines.' : 'Live GitLab data is needed to show the release state.']
  }[gate.state];
  $('gate-title').textContent = copy[0];
  $('gate-text').textContent = copy[1];

  const action = $('gate-action');
  if (gate.job?.web_url) {
    action.hidden = false;
    action.href = gate.job.web_url;
    action.textContent = gate.state === 'awaiting' ? 'Review & approve in GitLab' : 'Open gate job';
  } else action.hidden = true;

  // Only describe the image here if the evidence snapshot is for the same commit
  // as the pipeline the gate belongs to.
  const sameCommit = !pipe || !evidence?.pipeline || evidence.pipeline.sha === pipe.sha;
  const image = sameCommit ? evidence?.image : null;
  const digest = image?.imageRef?.split('@')[1] ?? null;
  const other = evidence?.pipeline ? `see pipeline #${evidence.pipeline.iid}` : 'missing';
  const facts = [
    ['Commit', pipe ? shortSha(pipe.sha) : '—'],
    ['Image digest', digest ? `${digest.slice(0, 19)}…` : sameCommit ? 'missing' : 'not in snapshot yet'],
    ['Signature + provenance', !sameCommit ? other : evidence?.signature ? (evidence.signature.verified ? 'Sigstore verified' : 'not verified') : 'missing'],
    ['Approver', gate.approver ?? (gate.state === 'awaiting' ? 'pending' : '—')]
  ];
  $('gate-facts').replaceChildren(...facts.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { class: k === 'Image digest' || k === 'Commit' ? 'mono' : '' }, v))));
}

function renderStages(live, evidence) {
  const newest = live?.guardian?.[0]?.mr ?? null;
  const ev = evidence ? { provenance: evidence.provenance, signature: evidence.signature } : null;
  const stages = mapStages({
    jobs: [...(live?.jobs ?? []), ...(live?.monitorJobs ?? [])],
    pipeline: live?.latest ?? null,
    guardianMr: newest,
    evidence: ev,
    runtime: live?.monitor?.runtime ?? null
  });
  $('stages').replaceChildren(
    ...stages.map((s, i) =>
      h('li', { class: 'stage', dataset: { tone: s.tone } },
        h('span', { class: 'stage-num' }, String(i + 1).padStart(2, '0')),
        h('span', { class: 'stage-name' }, s.label),
        h('span', { class: 'stage-what' }, s.what),
        h('span', { class: 'stage-status' }, dot(s.tone), s.status === 'no-data' ? 'no data' : s.status),
        s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener' }, h('span', { class: 'stage-detail' }, s.detail)) : h('span', { class: 'stage-detail' }, s.detail)
      )
    )
  );
  const p = live?.latest;
  $('lifecycle-meta').replaceChildren(
    p ? link(p.web_url, `Pipeline #${p.iid ?? p.id} · ${shortSha(p.sha)} · ${p.status} · ${formatAgo(p.created_at)}`) : document.createTextNode('No live pipeline data'),
    newest ? document.createTextNode(' · Duo stages from the newest guardian MR') : '',
    live?.monitorPipeline
      ? h('span', {}, ' · ', link(live.monitorPipeline.web_url, `live check ${live.monitorPipeline.status} ${formatAgo(live.monitorPipeline.created_at)}`))
      : ''
  );
}

// Watch: the scheduled production monitor and the incidents the Duo flow opened from it.
function renderWatch(live) {
  const unavailable = h('div', { class: 'empty' }, 'Live GitLab data unavailable; not shown as healthy.');
  const runsKnown = Array.isArray(live?.monitorRuns);
  const runs = summariseMonitorRuns(live?.monitorRuns ?? []);
  const result = summariseMonitorResult(live?.monitor);
  $('watch-tag').className = `tag ${result ? (result.ok ? 'tag-pass' : 'tag-fail') : ''}`;
  $('watch-tag').textContent = result ? (result.ok ? 'production matches release' : 'drift or failing probe') : runsKnown ? 'no run yet' : 'unavailable';
  $('watch-summary').replaceChildren(
    result
      ? h('div', { class: 'watch-result' },
          h('b', {}, `${result.checksPassed}/${result.checksTotal}`), h('span', {}, 'config checks vs the approved release'),
          h('b', {}, `${result.probesPassed}/${result.probesTotal}`), h('span', {}, 'live user-journey probes'),
          ...(result.drift.length ? [h('div', { class: 'watch-drift' }, `DRIFT ${result.drift.join(' · ')}`)] : []))
      : runsKnown && runs.runs.length === 0 ? h('div', { class: 'empty' }, 'No scheduled monitor run yet.') : unavailable
  );
  $('watch-runs').replaceChildren(
    ...runs.runs.slice().reverse().map((r) =>
      h('a', { class: 'run', dataset: { tone: r.tone }, href: r.url, target: '_blank', rel: 'noopener', title: `${r.status} · ${formatAgo(r.at)}` }, '')
    )
  );
  const newestJob = live?.monitorJobs?.[0];
  $('watch-runs-meta').replaceChildren(
    runs.runs.length ? `last ${runs.runs.length} scheduled runs: ${runs.passed} passed, ${runs.failed} failed · newest ${formatAgo(runs.runs[0].at)}` : '',
    newestJob ? h('span', {}, ' · ', link(newestJob.web_url, 'open the newest monitor job')) : ''
  );
  const incidentsKnown = Array.isArray(live?.incidents);
  const incidents = live?.incidents ?? [];
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'not recorded');
  $('incident-story').replaceChildren(
    ...incidentStory(incidents[0], live?.storyRuns ?? []).map((step, n) =>
      h('li', { class: 'story-step', dataset: { done: String(step.done) } },
        h('span', { class: 'story-num' }, String(n + 1)),
        h('div', {},
          step.url ? link(step.url, step.label, 'story-label') : h('span', { class: 'story-label' }, step.label),
          h('div', { class: 'mr-meta' }, when(step.at)))))
  );
  $('incident-story').hidden = incidents.length === 0;
  $('incident-list').replaceChildren(
    ...(incidents.length
      ? incidents.map((i) =>
          h('li', { class: 'incident' },
            h('div', { class: 'incident-head' },
              h('span', { class: `tag ${i.state === 'closed' ? 'tag-pass' : 'tag-fail'}` }, i.state === 'closed' ? 'resolved' : 'open'),
              link(i.url, `#${i.iid} ${i.title}`, 'mr-title')),
            h('div', { class: 'mr-meta' },
              `opened by ${i.openedByDuo ? 'the Duo flow' : i.openedBy} ${formatAgo(i.openedAt)}` +
              (i.closedAt ? ` · resolved by ${i.closedBy ?? 'a person'} ${formatAgo(i.closedAt)}` : ' · awaiting a person'))))
      : [h('li', { class: 'empty' }, incidentsKnown ? 'No incidents. The Duo flow opens one when a scheduled check fails.' : 'Live GitLab data unavailable; incidents not shown.')])
  );
}

function renderMrs(live) {
  const list = $('mr-list');
  if (!live) return list.replaceChildren(h('li', { class: 'empty' }, 'Live GitLab data is needed to list Duo merge requests.'));
  if (live.guardian.length === 0) return list.replaceChildren(h('li', { class: 'empty' }, 'No remediation merge requests yet. They appear here after the Duo flow handles a failed pipeline.'));
  list.replaceChildren(
    ...live.guardian.map(({ summary: s }) =>
      h('li', { class: 'mr' },
        link(s.url, `!${s.iid} ${s.title}`, 'mr-title'),
        h('div', { class: 'mr-meta' }, `${s.state} · ${s.sourceBranch} → ${s.targetBranch} · by ${s.author ?? 'unknown'} · ${formatAgo(s.createdAt)}`),
        h('div', { class: 'checks' },
          ...Object.entries(s.checks).map(([name, status]) => h('span', { class: 'check' }, dot(toneFor(status)), `${name}: ${status}`)),
          h('span', { class: `tag ${s.verified ? 'tag-pass' : 'tag-gate'}` }, s.verified ? 'verified fix' : 'not verified')
        ),
        s.proof ? h('div', { class: 'proof' }, `Regression proof: ${s.proof.verdict}. ${s.proof.reason}`) : null
      )
    )
  );
}

function renderProvenance(evidence) {
  const p = evidence?.provenance;
  const tag = $('prov-tag');
  if (!p) {
    tag.className = 'tag tag-fail';
    tag.textContent = 'missing';
    $('prov').replaceChildren(h('div', { class: 'empty' }, 'No provenance in this build’s evidence.'));
    $('prov-links').replaceChildren();
    return;
  }
  tag.className = `tag ${p.verified ? 'tag-pass' : 'tag-fail'}`;
  tag.textContent = p.verified ? 'verified' : 'verification failed';
  const sig = evidence.signature;
  const rows = [
    ['Image', p.subject ? `${p.subject.name}@sha256:${p.subject.digest?.sha256 ?? ''}` : '—'],
    ['Source commit', p.commit ?? '—'],
    ['Base image', p.baseImage ? `${p.baseImage.uri.replace('docker://', '')}@sha256:${(p.baseImage.digest?.sha256 ?? '').slice(0, 12)}…` : '—'],
    ['Builder', p.builder ?? '—'],
    ['Format', p.predicateType ?? '—'],
    ['Signature', sig ? (sig.verified ? `image signature + SLSA attestation verified (${sig.identity ?? ''})` : sig.detail ?? 'not verified') : 'missing']
  ];
  if (!p.verified) rows.push(['Failed checks', p.failedChecks.join('; ')]);
  $('prov').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: /Image|commit|Base/.test(k) ? 'mono' : '' }, v)]));
  $('prov-links').replaceChildren(
    ...[['Provenance statement', p.statementUrl], ['Build job', p.invocation?.startsWith('http') ? p.invocation : null]]
      .filter(([, u]) => u)
      .map(([t, u]) => link(u, t))
  );
}

function renderSecurity(evidence) {
  const s = evidence?.security;
  const tag = $('sec-tag');
  if (!s) {
    tag.className = 'tag tag-fail';
    tag.textContent = 'missing';
    $('sev-row').replaceChildren();
    $('findings').replaceChildren(h('li', { class: 'empty' }, 'No security summary in this build’s evidence.'));
    return;
  }
  tag.className = `tag ${s.passed ? 'tag-pass' : 'tag-fail'}`;
  tag.textContent = s.passed ? 'passed' : 'blocked';
  $('sev-row').replaceChildren(...['Critical', 'High', 'Medium', 'Low'].map((k) => h('div', { class: 'sev' }, h('b', {}, String(s.counts?.[k] ?? 0)), h('span', {}, k))));
  const items = [
    ...s.problems.map((p) => h('li', { class: 'finding' }, dot('fail'), h('span', {}, p))),
    ...s.findings.map((f) => h('li', { class: 'finding' }, dot(f.blocking ? 'fail' : 'gate'), h('span', {}, `[${f.severity}] ${f.name} `, h('span', { class: 'loc' }, f.dependency ?? (f.file ? `${f.file}:${f.line ?? '?'}` : f.scanType)))))
  ];
  $('findings').replaceChildren(...(items.length ? items : [h('li', { class: 'empty' }, 'No findings from Semgrep or secret detection on this commit.')]));
}

function renderDeploy(live, evidence) {
  const d = live?.deploy;
  const tag = $('deploy-tag');
  const tone = { deployed: 'tag-pass', rolled_back: 'tag-fail', blocked: 'tag-fail', failed: 'tag-fail' }[d?.status] ?? '';
  tag.className = `tag ${tone}`;
  tag.textContent = d ? d.status.replace('_', ' ') : live ? 'not deployed yet' : 'no live data';
  const rows = d
    ? [
        ['Live URL', d.url ? link(d.url, d.url) : '—'],
        ['Revision', d.revision || '—'],
        ['Previous', d.previousRevision || '—'],
        ['Image', d.image || '—'],
        ['Result', d.detail || '—'],
        ['When', formatAgo(d.at)]
      ]
    : [['Status', live ? 'No deploy_production job has published a result yet.' : 'Live GitLab data is needed.']];
  $('deploy').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', { class: k === 'Image' || k === 'Revision' || k === 'Previous' ? 'mono' : '' }, v)]));
  const live_ = $('live-link');
  // Reset on every refresh so a link never outlives the deploy result it came from.
  live_.hidden = !(d?.url && d.status === 'deployed');
  $('gate-live').hidden = live_.hidden;
  if (!live_.hidden) {
    live_.href = d.url;
    $('gate-live').href = d.url;
  }
  const s = evidence?.smoke;
  if (!s) return $('probes').replaceChildren(h('li', { class: 'empty' }, 'No image smoke result in this build’s evidence.'));
  $('probes').replaceChildren(...s.probes.map((p) => h('li', { class: 'probe' }, h('span', { class: 'status' }, dot(p.ok ? 'pass' : 'fail'), p.name), h('span', { class: 'mono muted' }, `${p.detail ?? ''} · ${p.ms} ms`))));
}

function renderCarbon(evidence) {
  const c = evidence?.carbon;
  const tag = $('carbon-tag');
  if (!c) {
    tag.className = 'tag tag-fail';
    tag.textContent = 'missing';
    $('carbon').replaceChildren(h('div', { class: 'empty' }, 'No carbon report in this build’s evidence.'));
    return;
  }
  tag.className = 'tag tag-pass';
  tag.textContent = `${c.sciGramsPerPipeline.toFixed(1)} gCO₂e`;
  const rows = [
    ['SCI', `${c.sciGramsPerPipeline.toFixed(2)} gCO₂e per pipeline run`],
    ['Energy (E)', `${(c.energyKwh * 1000).toFixed(1)} Wh over ${c.runnerSeconds} runner-seconds (${c.jobsMeasured} jobs)`],
    ['Operational (E×I)', `${c.operationalGrams.toFixed(2)} g at ${c.gridGramsPerKwh} g/kWh`],
    ['Embodied (M)', `${c.embodiedGrams.toFixed(2)} g`],
    ['Not included', c.boundary?.excluded ?? '—']
  ];
  $('carbon').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

function renderPipelines(live) {
  const body = $('pipelines').tBodies[0];
  if (!live) return body.replaceChildren(h('tr', {}, h('td', { colspan: '5', class: 'empty' }, 'Live GitLab data unavailable.')));
  if (!live.pipelines.length) return body.replaceChildren(h('tr', {}, h('td', { colspan: '5', class: 'empty' }, 'No pipelines yet.')));
  body.replaceChildren(
    ...live.pipelines.map((p) =>
      h('tr', {},
        h('td', {}, link(p.web_url, `#${p.iid ?? p.id}`)),
        h('td', { class: 'mono' }, p.ref),
        h('td', { class: 'mono' }, shortSha(p.sha)),
        h('td', {}, h('span', { class: 'status' }, dot(toneFor(p.status)), p.status)),
        h('td', { class: 'muted' }, formatAgo(p.created_at))
      )
    )
  );
}

function renderReleases(live) {
  const list = $('releases');
  if (!live) return list.replaceChildren(h('li', { class: 'empty' }, 'Live GitLab data unavailable.'));
  if (!live.releases.length) return list.replaceChildren(h('li', { class: 'empty' }, 'No releases yet. A release is created only after the gate approves.'));
  list.replaceChildren(
    ...live.releases.map((r) =>
      h('li', { class: 'mr' },
        link(r._links?.self, r.name || r.tag_name, 'mr-title'),
        h('div', { class: 'mr-meta' }, `${r.tag_name} · ${shortSha(r.commit?.id)} · ${formatAgo(r.released_at)}`)
      )
    )
  );
}

/* ---------------------------------------------------------------- boot */

async function refresh(config, evidence) {
  let live = null;
  let error = null;
  if (config?.apiUrl && config?.projectId) {
    try {
      live = await loadLive(config);
    } catch (err) {
      error = err.message;
    }
  }
  renderHeader(config, live, error);
  const notes = [];
  if (!config?.projectId) notes.push('This page is not connected to a GitLab project. It is populated by the `pages` CI job.');
  if (error) notes.push(`Live GitLab data could not be loaded (${error}). Showing this build’s evidence only.`);
  if (live?.latest && evidence?.pipeline && live.latest.sha !== evidence.pipeline.sha) {
    notes.push(`The security, image, provenance and carbon panels describe pipeline #${evidence.pipeline.iid} (commit ${shortSha(evidence.pipeline.sha)}). The latest pipeline is #${live.latest.iid ?? live.latest.id} (commit ${shortSha(live.latest.sha)}); this page updates when that pipeline publishes.`);
  }
  if (evidence?.missing?.length) notes.push(`Missing from this build’s evidence: ${evidence.missing.join(', ')}.`);
  renderNotice(notes.join(' '));
  renderGate(config, live, evidence);
  renderStages(live, evidence);
  renderWatch(live);
  renderMrs(live);
  renderProvenance(evidence);
  renderSecurity(evidence);
  renderDeploy(live, evidence);
  renderCarbon(evidence);
  renderPipelines(live);
  renderReleases(live);
  if (evidence?.pipeline) $('footer-pipeline').replaceChildren(link(evidence.pipeline.url, `pipeline #${evidence.pipeline.iid}`));
}

async function main() {
  const [config, evidence] = await Promise.all([tryJson('config.json'), tryJson('evidence.json')]);
  await refresh(config, evidence);
  if (config?.projectId) {
    setInterval(() => { if (!document.hidden) refresh(config, evidence); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(config, evidence); });
  }
}

main();
