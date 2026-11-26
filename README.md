# MergeWitness

MergeWitness is a release approval registry for maintainers, release engineers and
automation that need evidence of what actually passed CI. A successful run for
another commit or another workflow cannot approve a release.

## Review the live app

1. Open [MergeWitness](https://mergewitness.vercel.app/) and click **Load example**.
   The app reads the policy and approval from finalized GenLayer state. No wallet
   is required for lookup. If the live read fails, the example shows the recorded
   approval with a clear label and its finalized transaction link.
2. Confirm **Approved release** refers to `openai/openai-node` PR 3192, its merge
   SHA and CI run 45688945469, attempt 1. Open **Finalized receipt** to inspect
   the verification transaction. The PR and workflow belong to the public
   demonstration repository.
3. To rerun the check, connect an injected EIP-1193 wallet and approve the
   network switch and **Verify on GenLayer** transaction. Use a Studio test
   account and fund it with test GEN from the Studio faucet if needed. The
   workspace shows the transaction and tracks it through finality. If tracking
   is interrupted, **Resume tracking** reuses the saved hash.
4. To check rejection, load the example and replace the run ID with
   `45688945475`. GitHub reports success on the same SHA for that run, but it
   belongs to a different workflow. The contract rejects it. The existing
   successful approval remains tied to the original evidence.

See [the deployment evidence](deployments/studio.json) for the address,
source hash, policy and verification transactions. [The example input](deployments/example.json)
identifies the GitHub PR and exact run attempts.

The [Studio demo run](https://github.com/Starling-spell/mergewitness/actions/runs/45696057354)
verified deployed source and finalized policy creation, rejection and approval
receipts. The rejection finalized with `MW_WRONG_WORKFLOW` while the approval
gate was still closed. The matching attempt then opened the gate for the exact
merge SHA.

## Create a policy

In **Register policy**, enter a public repository, its numeric GitHub repository
ID, the target branch, and the numeric workflow ID. Find the IDs in the official
GitHub API responses:

```sh
gh api repos/OWNER/REPO --jq '.id'
gh api repos/OWNER/REPO/actions/workflows --jq '.workflows[] | [.id,.path] | @tsv'
```

Register the policy on GenLayer, then enter the merged PR number, merge SHA,
workflow run ID and attempt number. The workflow must have run on a push to the
policy branch. MergeWitness intentionally checks the resulting merge commit,
which can differ from the premerge PR head. The policy ID is
`owner/repo:repository-id:branch:workflow-id`.

## Use a release approval in automation

```sh
npm ci
npm run approval -- openai/openai-node:438419937:main:73866226 be6cf76e14988df37b8c280fdc01184bb2c7d52e
```

This read-only command exits 0 with a matching finalized approval, 2 for a
missing approval, and 1 if the network or record could not be verified. A release
job can run it before publishing. An Intelligent Contract can use
`is_approved(policy_id, sha)` against the configured deployment and finalized
state. Consumers choose and pin the policy ID and contract address they trust.
Anyone can register a policy and request verification. Registration grants no
permission to approve arbitrary commits.

## Trust and scope

GenLayer validators independently fetch public GitHub REST responses for the PR
and the numbered workflow attempt. They compare normalized facts with
`strict_eq`. The contract checks repository ID and name, branch, merge SHA,
workflow ID, attempt identity, push event and successful completion. Fetch
errors, incomplete runs and mismatches produce no approval. A successful check
creates one permanent record per policy and SHA, with a digest and source
identifiers. Rechecking cannot replace the original approval.

Approvals describe GitHub's reported state at verification time. GitHub and
repository maintainers remain responsible for source availability and what the
pinned workflow actually tests. A passing workflow establishes no guarantee
about code quality, artifact integrity or deployment. Private repositories
and historical runs deleted from GitHub are outside the supported flow.

## Run and verify

```sh
npm ci
npm run dev
npm run build
npm run chain
```

`npm run chain` checks the deployed source hash, finalized approval state and
positive and negative receipts. `npm run chain -- --deploy` creates a fresh
test deployment with an in-memory wallet and faucet GEN. It journals hashes in
`.studio-state/studio-run.json` as soon as they are submitted. Inspect that journal
if a run stops. `npm run chain -- --resume` tracks the saved hashes and can
submit the remaining permissionless demo steps.

```sh
genvm-lint check contracts/merge_witness.py --json
```

Run the browser checks with `npx playwright install chromium` followed by
`npm run qa:browser`. Use `npm run build` and
`npm run qa:browser -- --local` for the current build. Adding `--live-wallet`
uses a fresh faucet-funded Studio wallet to exercise policy registration,
reloading during a transaction, and both verification outcomes.

The Vercel site is a static Vite app. It sends reads to the public GenLayer RPC
and wallet-signed writes directly to GenLayer.
