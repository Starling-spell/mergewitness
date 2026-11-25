# v0.2.0
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import hashlib
import json
import re


def canonical(data: dict) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


def valid_id(value: int) -> bool:
    return type(value) is int and 0 < value < 2**53


def github_json(path: str) -> dict:
    try:
        response = gl.nondet.web.get("https://api.github.com/repos/" + path)
        if response.status != 200 or len(response.body) > 1_500_000:
            return {}
        data = json.loads(response.body.decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def assess(policy: dict, pull: int, run: int, attempt: int, sha: str) -> dict:
    repo = policy["repo"]
    pr = github_json(f"{repo}/pulls/{pull}")
    if not pr:
        return {"outcome": "PR_UNAVAILABLE"}
    base = pr.get("base") or {}
    base_repo = base.get("repo") or {}
    if pr.get("number") != pull or base_repo.get("id") != policy["repository_id"]:
        return {"outcome": "PR_IDENTITY"}
    if str(base_repo.get("full_name", "")).lower() != repo or base.get("ref") != policy["branch"]:
        return {"outcome": "PR_TARGET"}
    merged_at = pr.get("merged_at")
    if pr.get("merged") is not True or not isinstance(merged_at, str) or not merged_at:
        return {"outcome": "PR_NOT_MERGED"}
    if pr.get("merge_commit_sha") != sha:
        return {"outcome": "MERGE_SHA_MISMATCH"}

    ci = github_json(f"{repo}/actions/runs/{run}/attempts/{attempt}")
    if not ci:
        return {"outcome": "CI_UNAVAILABLE"}
    run_repo = ci.get("repository") or {}
    head_repo = ci.get("head_repository") or {}
    if (ci.get("id") != run or ci.get("run_attempt") != attempt
            or run_repo.get("id") != policy["repository_id"]
            or head_repo.get("id") != policy["repository_id"]
            or str(run_repo.get("full_name", "")).lower() != repo
            or str(head_repo.get("full_name", "")).lower() != repo):
        return {"outcome": "CI_IDENTITY"}
    if ci.get("workflow_id") != policy["workflow_id"]:
        return {"outcome": "WRONG_WORKFLOW"}
    if ci.get("head_branch") != policy["branch"] or ci.get("event") != "push":
        return {"outcome": "CI_TARGET"}
    if ci.get("head_sha") != sha:
        return {"outcome": "CI_SHA_MISMATCH"}
    if ci.get("status") != "completed":
        return {"outcome": "CI_PENDING"}
    if ci.get("conclusion") != "success":
        return {"outcome": "CI_NOT_SUCCESS"}
    started_at = ci.get("run_started_at")
    if not isinstance(started_at, str) or not started_at:
        return {"outcome": "CI_UNAVAILABLE"}
    return {"outcome": "APPROVED", "merged_at": merged_at, "run_started_at": started_at}


class MergeWitness(gl.Contract):
    policies: TreeMap[str, str]
    approvals: TreeMap[str, str]
    policy_count: u64
    approval_count: u64

    def __init__(self):
        self.policy_count = u64(0)
        self.approval_count = u64(0)

    @gl.public.write
    def register_policy(self, repo: str, repository_id: int, branch: str, workflow_id: int) -> str:
        repo = repo.lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_][a-z0-9_.-]{0,99}", repo) or repo.endswith("."):
            raise gl.vm.UserError("MW_INVALID_REPO")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\/-]{0,99}", branch):
            raise gl.vm.UserError("MW_INVALID_BRANCH")
        if not valid_id(repository_id) or not valid_id(workflow_id):
            raise gl.vm.UserError("MW_INVALID_ID")
        key = f"{repo}:{repository_id}:{branch}:{workflow_id}"
        if self.policies.get(key, ""):
            return key
        self.policies[key] = canonical({
            "id": key, "repo": repo, "repository_id": repository_id,
            "branch": branch, "workflow_id": workflow_id,
        })
        self.policy_count += u64(1)
        return key

    @gl.public.write
    def verify_merge(self, policy_id: str, pull: int, run: int, attempt: int, sha: str) -> str:
        if (len(policy_id) > 300 or not all(valid_id(x) for x in (pull, run, attempt))
                or not re.fullmatch(r"[0-9a-f]{40}", sha)):
            raise gl.vm.UserError("MW_INVALID_PROOF")
        raw = self.policies.get(policy_id, "")
        if not raw:
            raise gl.vm.UserError("MW_UNKNOWN_POLICY")
        policy = json.loads(raw)
        def observe():
            return canonical(assess(policy, pull, run, attempt, sha))

        facts = json.loads(gl.eq_principle.strict_eq(observe))
        if facts["outcome"] != "APPROVED":
            raise gl.vm.UserError("MW_" + facts["outcome"])
        approval_key = policy_id + ":" + sha
        record = self.approvals.get(approval_key, "")
        if record:
            return json.loads(record)["digest"]
        record = {
            "policy": policy, "sha": sha, "pull": pull, "run": run, "attempt": attempt,
            "merged_at": facts["merged_at"], "run_started_at": facts["run_started_at"],
        }
        digest = hashlib.sha256(canonical(record).encode("utf-8")).hexdigest()
        record["digest"] = digest
        self.approvals[approval_key] = canonical(record)
        self.approval_count += u64(1)
        return digest

    @gl.public.view
    def get_policy(self, policy_id: str) -> str:
        return self.policies.get(policy_id, "") if len(policy_id) <= 300 else ""

    @gl.public.view
    def get_approval(self, policy_id: str, sha: str) -> str:
        if len(policy_id) > 300 or not re.fullmatch(r"[0-9a-f]{40}", sha):
            return ""
        return self.approvals.get(policy_id + ":" + sha, "")

    @gl.public.view
    def is_approved(self, policy_id: str, sha: str) -> bool:
        return bool(self.get_approval(policy_id, sha))

    @gl.public.view
    def get_counts(self) -> dict:
        return {"policies": int(self.policy_count), "approvals": int(self.approval_count)}
