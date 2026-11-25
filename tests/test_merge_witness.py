import copy
import hashlib
import json
import re

import pytest


REPO = "example/tool"
REPO_ID = 1200
WORKFLOW = 7565
SHA = "4" * 40
PR = 18
RUN = 4321
ATTEMPT = 2
REPO_FACT = {"id": REPO_ID, "full_name": REPO}
PR_FACT = {
    "number": PR, "base": {"ref": "main", "repo": REPO_FACT},
    "merged": True, "merged_at": "2026-11-25T10:00:00Z", "merge_commit_sha": SHA,
}
CI_FACT = {
    "id": RUN, "run_attempt": ATTEMPT, "repository": REPO_FACT, "head_repository": REPO_FACT,
    "workflow_id": WORKFLOW, "head_branch": "main", "event": "push", "head_sha": SHA,
    "status": "completed", "conclusion": "success", "run_started_at": "2026-11-25T10:01:00Z",
}


@pytest.fixture
def gate(direct_deploy):
    contract = direct_deploy("contracts/merge_witness.py")
    key = contract.register_policy(REPO, REPO_ID, "main", WORKFLOW)
    return contract, key


def evidence(vm, pr=PR_FACT, ci=CI_FACT, pr_status=200, ci_status=200):
    vm.clear_mocks()
    base = "https://api.github.com/repos/" + REPO
    vm.mock_web(re.escape(f"{base}/pulls/{PR}") + "$", {"status": pr_status, "body": json.dumps(pr)})
    vm.mock_web(re.escape(f"{base}/actions/runs/{RUN}/attempts/{ATTEMPT}") + "$",
                {"status": ci_status, "body": json.dumps(ci)})


def test_approval_is_bound_to_policy_and_commit(gate, direct_vm):
    contract, key = gate
    evidence(direct_vm)
    digest = contract.verify_merge(key, PR, RUN, ATTEMPT, SHA)
    record = json.loads(contract.get_approval(key, SHA))
    assert record.pop("digest") == digest
    assert hashlib.sha256(json.dumps(record, separators=(",", ":"), sort_keys=True).encode()).hexdigest() == digest
    assert (record["pull"], record["run"], record["attempt"]) == (PR, RUN, ATTEMPT)
    assert contract.is_approved(key, SHA)
    assert not contract.is_approved(key, "5" * 40)
    other = contract.register_policy(REPO, REPO_ID, "main", WORKFLOW + 1)
    assert not contract.is_approved(other, SHA)
    assert contract.verify_merge(key, PR, RUN, ATTEMPT, SHA) == digest
    assert contract.get_counts()["approvals"] == 1


@pytest.mark.parametrize("target,field,value,reason", [
    ("pr", "merged", False, "PR_NOT_MERGED"),
    ("pr", "merge_commit_sha", "5" * 40, "MERGE_SHA_MISMATCH"),
    ("pr", "base", {"ref": "development", "repo": REPO_FACT}, "PR_TARGET"),
    ("ci", "workflow_id", WORKFLOW + 1, "WRONG_WORKFLOW"),
    ("ci", "run_attempt", ATTEMPT + 1, "CI_IDENTITY"),
    ("ci", "head_repository", {"id": 999, "full_name": "other/tool"}, "CI_IDENTITY"),
    ("ci", "event", "pull_request", "CI_TARGET"),
    ("ci", "head_sha", "5" * 40, "CI_SHA_MISMATCH"),
    ("ci", "status", "in_progress", "CI_PENDING"),
    ("ci", "conclusion", "failure", "CI_NOT_SUCCESS"),
])
def test_mismatches_leave_gate_closed(gate, direct_vm, target, field, value, reason):
    contract, key = gate
    pr, ci = copy.deepcopy(PR_FACT), copy.deepcopy(CI_FACT)
    (pr if target == "pr" else ci)[field] = value
    evidence(direct_vm, pr, ci)
    with pytest.raises(Exception, match="MW_" + reason):
        contract.verify_merge(key, PR, RUN, ATTEMPT, SHA)
    assert not contract.is_approved(key, SHA)
    assert contract.get_counts()["approvals"] == 0


def test_unavailable_evidence_can_be_retried(gate, direct_vm):
    contract, key = gate
    evidence(direct_vm, ci_status=429)
    with pytest.raises(Exception, match="MW_CI_UNAVAILABLE"):
        contract.verify_merge(key, PR, RUN, ATTEMPT, SHA)
    assert not contract.is_approved(key, SHA)
    evidence(direct_vm)
    contract.verify_merge(key, PR, RUN, ATTEMPT, SHA)
    assert contract.is_approved(key, SHA)


def test_untrusted_repo_path_cannot_be_registered(gate):
    contract, key = gate
    with pytest.raises(Exception, match="MW_INVALID_REPO"):
        contract.register_policy("example/tool/../../secret", REPO_ID, "main", WORKFLOW)
    assert contract.register_policy(REPO.upper(), REPO_ID, "main", WORKFLOW) == key
    assert contract.get_counts()["policies"] == 1
