#!/bin/sh
# Start the demo: push a realistic Kutt feature ("sort links by any column")
# whose implementation interpolates request input into an ORDER BY clause,
# and open a merge request for it.
#
# What should happen next (all real):
#   1. The MR's tests pass, but security_gate blocks the pipeline.
#   2. The failed pipeline triggers the Omnis Guardian Duo flow, which posts a
#      diagnosis and fix plan on the MR and waits for approval.
#   3. You approve by replying "@<guardian service account> approve".
#   4. The flow opens a guardian/fix-* MR; its regression_proof job proves the fix.
#
# Run from the root of your clone, on an up-to-date main branch.
set -eu
BRANCH="${1:-feature/sortable-links}"

git fetch origin main
git switch -c "$BRANCH" origin/main
git apply guardian/demo/sortable-links.patch
git add server/ test/
git commit -m "feat: sort links by any column"
git push -u origin "$BRANCH" \
  -o merge_request.create \
  -o merge_request.target=main \
  -o merge_request.title="Sort links by any column"

echo
echo "Pushed $BRANCH and opened a merge request. Watch its pipeline in GitLab."
