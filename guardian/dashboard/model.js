// Pure data mapping for the dashboard. Everything shown on the page passes
// through these functions, and each output carries the GitLab source it came
// from. When data is missing the state is "no-data", never a guess.

export const STAGES = [
  { key: 'plan', label: 'Plan', what: 'Duo diagnoses and posts a plan for approval', source: 'duo' },
  { key: 'create', label: 'Create', what: 'Approved plan becomes a fix MR + regression test', source: 'duo' },
  { key: 'verify', label: 'Verify', what: 'Kutt integration tests + regression proof', jobs: ['unit_tests', 'regression_proof'] },
  { key: 'package', label: 'Package', what: 'Container image built and booted', jobs: ['build_image', 'smoke_image'] },
  { key: 'secure', label: 'Secure', what: 'Semgrep, secrets and dependency gate', jobs: ['security_gate'] },
  { key: 'release', label: 'Release', what: 'Approver-checked gate, then GitLab release', jobs: ['release_gate', 'publish_release'] },
  { key: 'configure', label: 'Configure', what: 'Runtime config as code, drift-checked every two hours; pipeline and flow validated', jobs: ['config_check'], evidence: 'runtime' },
  { key: 'monitor', label: 'Monitor', what: 'Live probes every two hours; canary, promote, auto-rollback on deploy', jobs: ['deploy_production', 'monitor_production'] },
  { key: 'govern', label: 'Govern', what: 'Signatures, provenance and carbon verified', jobs: ['verify_signatures', 'carbon_report'], evidence: 'provenance' }
];

const TONE = {
  success: 'pass',
  failed: 'fail',
  canceled: 'fail',
  running: 'run',
  pending: 'run',
  preparing: 'run',
  waiting_for_resource: 'run',
  created: 'idle',
  scheduled: 'idle',
  manual: 'gate',
  skipped: 'idle'
};

export function toneFor(status) {
  return TONE[status] ?? 'idle';
}

/** Latest attempt of each job name (GitLab lists retries as separate jobs). */
export function latestJobs(jobs = []) {
  const byName = new Map();
  for (const job of jobs) {
    const prev = byName.get(job.name);
    if (!prev || job.id > prev.id) byName.set(job.name, job);
  }
  return byName;
}

function combine(statuses) {
  if (statuses.length === 0) return null;
  for (const s of ['failed', 'canceled', 'running', 'pending', 'manual', 'created']) {
    if (statuses.includes(s)) return s;
  }
  return statuses.every((s) => s === 'success' || s === 'skipped') ? 'success' : statuses[0];
}

/**
 * `jobs` may include the latest scheduled monitor_production job alongside the release
 * pipeline's jobs; `runtime` is that job's monitor-result.json drift checks.
 * @param {{ jobs?: any[], pipeline?: any, guardianMr?: any, evidence?: any, runtime?: any }} input
 */
export function mapStages({ jobs = [], pipeline = null, guardianMr = null, evidence = null, runtime = null }) {
  const byName = latestJobs(jobs);
  return STAGES.map((stage) => {
    if (stage.source === 'duo') {
      if (!guardianMr) {
        return { ...stage, status: 'no-data', tone: 'idle', detail: 'No Duo fix MR yet', url: null };
      }
      const state = guardianMr.state === 'merged' ? 'success' : guardianMr.state === 'closed' ? 'canceled' : 'success';
      const detail = stage.key === 'plan' ? `Diagnosis in !${guardianMr.iid}` : `!${guardianMr.iid} ${guardianMr.state}`;
      return { ...stage, status: state, tone: toneFor(state), detail, url: guardianMr.web_url };
    }
    const found = stage.jobs.map((n) => byName.get(n)).filter(Boolean);
    if (found.length === 0) {
      return { ...stage, status: 'no-data', tone: 'idle', detail: pipeline ? 'Job not in this pipeline' : 'No pipeline yet', url: null };
    }
    let status = combine(found.map((j) => j.status));
    let detail = found.map((j) => `${j.name}: ${j.status}`).join(' · ');
    if (stage.evidence === 'provenance' && evidence) {
      const signed = evidence.signature?.verified === true;
      detail = `${evidence.provenance?.verified ? 'provenance verified' : 'provenance not verified'} · ${signed ? 'signed' : 'unsigned'}`;
      if (status === 'success' && !evidence.provenance?.verified) status = 'failed';
    }
    if (stage.evidence === 'runtime' && runtime?.checks) {
      const drift = runtime.checks.filter((c) => !c.ok).map((c) => c.name);
      detail += drift.length ? ` · drift: ${drift.join(', ')}` : ' · live config matches release';
      if (drift.length) status = 'failed';
    }
    const primary = found.find((j) => j.status !== 'success') ?? found[0];
    return { ...stage, status, tone: toneFor(status), detail, url: primary.web_url ?? null };
  });
}

/** Release gate state from the latest default-branch pipeline's jobs. */
export function releaseGateState(jobs = []) {
  const byName = latestJobs(jobs);
  const gate = byName.get('release_gate');
  const publish = byName.get('publish_release');
  if (!gate) return { state: 'not-run', label: 'No release gate in this pipeline', job: null };
  switch (gate.status) {
    case 'manual':
      return { state: 'awaiting', label: 'Awaiting human approval', job: gate };
    case 'success':
      return {
        state: 'approved',
        label: publish?.status === 'success' ? 'Approved and released' : 'Approved',
        approver: gate.user?.username ?? null,
        approvedAt: gate.finished_at ?? null,
        job: gate,
        publish: publish ?? null
      };
    case 'failed':
      return { state: 'blocked', label: 'Blocked by the release gate', approver: gate.user?.username ?? null, job: gate };
    case 'running':
    case 'pending':
      return { state: 'running', label: 'Release gate running', job: gate };
    case 'created':
      return { state: 'waiting', label: 'Waiting for earlier stages', job: gate };
    default:
      return { state: 'not-run', label: `Release gate ${gate.status}`, job: gate };
  }
}

/** Is this merge request one the Duo remediation flow opened? */
export function isGuardianMr(mr) {
  return typeof mr?.source_branch === 'string' && mr.source_branch.startsWith('guardian/fix-');
}

export function summariseGuardianMr(mr, jobs = [], proof = null) {
  const byName = latestJobs(jobs);
  const job = (n) => byName.get(n)?.status ?? 'not run';
  return {
    iid: mr.iid,
    title: mr.title,
    url: mr.web_url,
    state: mr.state,
    author: mr.author?.username ?? null,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    createdAt: mr.created_at,
    checks: {
      regression_proof: job('regression_proof'),
      unit_tests: job('unit_tests'),
      security_gate: job('security_gate')
    },
    proof: proof
      ? { verdict: proof.verdict, reason: proof.reason, testFiles: proof.testFiles ?? [] }
      : null,
    verified:
      job('regression_proof') === 'success' && job('unit_tests') === 'success' && job('security_gate') === 'success'
  };
}

export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 12) : '—';
}

export function formatAgo(iso, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
