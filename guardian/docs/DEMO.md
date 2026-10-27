# Demo walkthrough (under 3 minutes)

Record only what actually happened in your GitLab project and Google Cloud. Run the whole
loop once before recording. The hackathon resources recommend a narrated walkthrough;
an AI voice-over is allowed. Use no copyrighted music.

| Time | Show | Say |
|---|---|---|
| 0:00–0:15 | Dashboard (Pages) and live Kutt | "Kutt is a popular open-source URL shortener. Omnis Guardian wraps it so a Duo agent does the investigative work after code is written, while a person approves the plan, the merge and the release." |
| 0:15–0:30 | First `main` pipeline: `security_gate` log listing 3 critical / 5 high npm advisories; then the upgrade MR passing | "On day one, the dependency gate found three critical and five high advisories in upstream Kutt. We fixed them and every test still passes." |
| 0:30–0:55 | MR "Sort links by any column": `unit_tests` green, `security_gate` red at the `orderByRaw` line | "A new feature passes its tests but puts request input straight into SQL. The gate blocks it." |
| 0:55–1:20 | The Duo plan comment on the MR (diagnosis, fix plan, "reply @… approve") | "Our Duo flow read the job log and the code, and posted a diagnosis and a plan. It does nothing until a maintainer approves." |
| 1:20–1:35 | Reply `@<account> approve`; the fix MR appears (diff + regression test) | "Approved. The flow checks I have Developer access, then opens a fix with a regression test." |
| 1:35–1:55 | `regression_proof` log: "On old code: … assertion failure(s)", "VERDICT: PROVEN" | "CI doesn't trust the agent. The new test must fail on the old code and pass on the fix." |
| 1:55–2:15 | Merge; `main` pipeline: build_image (signed + attested), smoke_image, verify_signatures | "On main we build the image, sign it and its provenance with Sigstore, and boot the image itself." |
| 2:15–2:40 | Start `release_gate` (PASS lines, approver); `deploy_production` log: candidate smoke → promote → production smoke | "I approve the release. The gate checks I'm an approved releaser and re-verifies the signatures. Cloud Run gets a no-traffic candidate first and rolls back on its own if production fails." |
| 2:40–2:55 | Dashboard refreshed; carbon card | "Every value here comes from GitLab or this pipeline, including what the pipeline cost in carbon. The only staged input is the risky feature, added to be caught." |

## Evidence checklist

- [ ] First `main` pipeline blocked by `security_gate` on upstream dependencies
- [ ] Dependency-upgrade MR with a passing pipeline
- [ ] Feature MR pipeline blocked by `security_gate` (Semgrep `og-sqli-knex-raw`)
- [ ] Duo plan comment + approval reply + Duo session link
- [ ] `guardian/fix-*` MR by the flow's service account; `regression_proof` PROVEN
- [ ] `build_image` log with `cosign sign` / `cosign attest`; `verify_signatures` result
- [ ] `release_gate` log with approver; GitLab release
- [ ] `deploy_production` log + live Cloud Run URL
- [ ] Pages dashboard URL; YouTube video (public, < 3 min)
