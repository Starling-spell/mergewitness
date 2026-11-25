import { StrictMode, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Hash } from 'genlayer-js/types';
import example from '../deployments/example.json';
import deployment from '../deployments/studio.json';
import {
  address, chain, delay, explorer, jsonView, network, read, reader, receiptFailure,
  repository, submit, wallet, walletError, type Approval, type Counts, type Policy,
} from './chain';
import './style.css';

type Pane = 'verify' | 'policy';
type Pending = { hash: Hash; policy: string; sha: string; kind: Pane };
const samplePolicy = [example.repo, example.repositoryId, example.branch, example.workflowId].join(':');
const storageKey = 'mergewitness:' + chain.id + ':' + address;
const shaPattern = /^[0-9a-f]{40}$/;
const txPattern = /^0x[0-9a-f]{64}$/i;
const positiveId = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const short = (value: string, n = 9) => value.slice(0, n) + '…' + value.slice(-5);
const gh = (repo: string) => 'https://github.com/' + repo;

function restore(): Pending | null {
  try {
    const task = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Pending | null;
    if (task && txPattern.test(task.hash) && typeof task.policy === 'string' &&
      (task.kind === 'policy' || (task.kind === 'verify' && shaPattern.test(task.sha)))) return task;
  } catch { /* Storage can be unavailable in private browsing. */ }
  return null;
}

function savePending(item: Pending | null) {
  try {
    if (item) localStorage.setItem(storageKey, JSON.stringify(item));
    else localStorage.removeItem(storageKey);
  } catch { /* The explorer link still tracks the current transaction. */ }
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const [pane, setPane] = useState<Pane>('verify');
  const [policyId, setPolicyId] = useState(params.get('policy') ?? samplePolicy);
  const [sha, setSha] = useState(params.get('sha') ?? example.sha);
  const [pull, setPull] = useState(String(example.pull));
  const [run, setRun] = useState(String(example.run));
  const [attempt, setAttempt] = useState(String(example.attempt));
  const [repo, setRepo] = useState('');
  const [repoId, setRepoId] = useState('');
  const [branch, setBranch] = useState('main');
  const [workflow, setWorkflow] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState('');
  const [pending, setPending] = useState<Pending | null>(restore);
  const [lastHash, setLastHash] = useState<Hash>();
  const [approval, setApproval] = useState<Approval | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [counts, setCounts] = useState<Counts>();
  const [loadState, setLoadState] = useState('Reading finalized state…');
  const operation = useRef(false);
  const readGeneration = useRef(0);

  async function lookup(id: string, commit: string) {
    const generation = ++readGeneration.current;
    setChecking(true);
    setLoadState('Reading finalized state…');
    try {
      const [metadata, certificate] = await Promise.all([
        jsonView<Policy>('get_policy', [id]),
        jsonView<Approval>('get_approval', [id, commit]),
      ]);
      if (generation !== readGeneration.current) return;
      setPolicy(metadata);
      setApproval(certificate);
      setLoadState(metadata ? certificate ? '' : 'This policy has no finalized approval for that commit.' : 'This policy has not been registered.');
    } catch {
      if (generation !== readGeneration.current) return;
      setPolicy(null);
      setApproval(null);
      setLoadState(address ? 'Studio could not return finalized state. Retry the lookup.' : 'The deployment address is pending.');
    } finally {
      if (generation === readGeneration.current) setChecking(false);
    }
  }

  function refreshCounts() {
    if (address) void read('get_counts').then(value => setCounts(value as Counts)).catch(() => {});
  }

  useEffect(() => {
    if (policyId && shaPattern.test(sha)) void lookup(policyId, sha);
    else { setLoadState('Enter a policy and full commit SHA.'); setChecking(false); }
    refreshCounts();
    const refreshAccount = () => { void wallet(false).then(w => setWalletAddress(w.account)).catch(() => setWalletAddress('')); };
    refreshAccount();
    const provider = window.ethereum;
    provider?.on?.('accountsChanged', refreshAccount);
    return () => {
      ++readGeneration.current;
      provider?.removeListener?.('accountsChanged', refreshAccount);
    };
  // Initial URL values are read once. The lookup button resolves subsequent edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeProof(setter: (value: string) => void, value: string) {
    ++readGeneration.current;
    setter(value);
    setPolicy(null);
    setApproval(null);
    setChecking(false);
    setLoadState('Look up this commit to check its finalized approval.');
  }

  async function connect() {
    setConnecting(true);
    setError('');
    try { setWalletAddress((await wallet()).account); }
    catch (error) { setError(walletError(error)); }
    finally { setConnecting(false); }
  }

  function useExample() {
    setPane('verify');
    setPolicyId(samplePolicy); setSha(example.sha); setPull(String(example.pull));
    setRun(String(example.run)); setAttempt(String(example.attempt));
    setError(''); setMessage('');
    void lookup(samplePolicy, example.sha);
  }

  async function track(item: Pending) {
    setLastHash(item.hash);
    for (let round = 0; round < 60; round++) {
      let receipt;
      try { receipt = await reader.getTransaction({ hash: item.hash }); }
      catch { setPhase('Waiting for the transaction to appear'); }
      if (receipt) {
        setPhase(String(receipt.statusName ?? 'Submitted').replaceAll('_', ' ').toLowerCase());
        if (receipt.statusName === 'FINALIZED' || receipt.statusName === 'CANCELED') {
          savePending(null);
          setPending(null);
          if (receipt.statusName !== 'FINALIZED' || receipt.resultName !== 'MAJORITY_AGREE' ||
              receipt.txExecutionResultName !== 'FINISHED_WITH_RETURN') {
            setError(receiptFailure(receipt.consensus_data?.leader_receipt));
            setPhase('Finalized without approval');
            return;
          }
          setPolicyId(item.policy);
          if (item.kind === 'verify') {
            setSha(item.sha);
            await lookup(item.policy, item.sha);
            setMessage('The verification transaction finalized successfully. The approval panel reads finalized contract state.');
          } else {
            setMessage('Policy registered. The verification form now has its policy ID.');
            setPane('verify');
            if (shaPattern.test(sha)) await lookup(item.policy, sha);
          }
          refreshCounts();
          return;
        }
      }
      await delay(4500);
    }
    setPhase('Still awaiting finality');
    setMessage('The transaction hash is saved. Resume tracking to check its status.');
  }

  async function runAction(event: FormEvent) {
    event.preventDefault();
    if (operation.current || pending) return;
    setError(''); setMessage('');
    if (!walletAddress) { await connect(); return; }
    const id = pane === 'verify' ? policyId.trim() : [repo.trim().toLowerCase(), Number(repoId), branch.trim(), Number(workflow)].join(':');
    const commit = sha.trim().toLowerCase();
    if (pane === 'verify' && (!id || id.length > 300 || !shaPattern.test(commit) || ![pull, run, attempt].every(positiveId))) {
      setError('Enter a policy ID, full commit SHA, and positive pull request, run and attempt numbers.');
      return;
    }
    if (pane === 'policy' && (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_][a-z0-9_.-]{0,99}$/i.test(repo.trim()) || repo.trim().endsWith('.') ||
      !/^[a-z0-9][a-z0-9_./-]{0,99}$/i.test(branch.trim()) || ![repoId, workflow].every(positiveId))) {
      setError('Enter a GitHub owner/repository, branch and positive repository and workflow IDs.');
      return;
    }
    operation.current = true;
    setBusy(true);
    setLastHash(undefined);
    setPhase('Awaiting wallet confirmation');
    try {
      const hash = await (pane === 'verify'
        ? submit('verify_merge', [id, Number(pull), Number(run), Number(attempt), commit])
        : submit('register_policy', [repo.trim().toLowerCase(), Number(repoId), branch.trim(), Number(workflow)]));
      const item = { hash, policy: id, sha: commit, kind: pane };
      savePending(item); setPending(item); setPhase('Submitted');
      await track(item);
    } catch (error) { setError(walletError(error)); setPhase(''); }
    finally { setBusy(false); operation.current = false; }
  }

  async function resume() {
    if (!pending || operation.current) return;
    operation.current = true; setBusy(true); setError(''); setMessage('');
    try { await track(pending); }
    finally { operation.current = false; setBusy(false); }
  }

  async function copyApproval() {
    if (!approval) return;
    const url = new URL(window.location.pathname, window.location.origin);
    url.search = new URLSearchParams({ policy: approval.policy.id, sha: approval.sha }).toString();
    try { await navigator.clipboard.writeText(url.href); setMessage('Approval link copied.'); }
    catch { setError('Clipboard is unavailable.'); }
  }

  const transactionHash = pending?.hash ?? lastHash;
  const loadedExample = approval?.policy.id === samplePolicy && approval?.sha === example.sha;

  return <>
    <header className="top">
      <div className="wrap nav">
        <a className="brand" href="/" aria-label="MergeWitness home"><img src="/logo.png" alt="" />MergeWitness</a>
        <div className="nav-actions">
          <span className="network"><i />{network}</span>
          <button className="button secondary" onClick={() => void connect()} disabled={connecting || busy}>
            {connecting ? 'Connecting…' : walletAddress ? short(walletAddress) : 'Connect wallet'}
          </button>
        </div>
      </div>
    </header>
    <main className="wrap">
      <section className="hero" aria-labelledby="page-title">
        <div>
          <p className="product">RELEASE VERIFICATION</p>
          <h1 id="page-title">Prove what passed.</h1>
          <p className="lede">Confirm that a pull request merged and the required CI workflow passed on the exact same commit. Share the finalized decision with anyone.</p>
        </div>
        <div className="lineage" aria-label="Pull request and CI evidence lead to a finalized approval">
          <span><b>01</b> Merged pull request</span>
          <span><b>02</b> Matching CI attempt</span>
          <span><b>03</b> GenLayer approval</span>
        </div>
      </section>
      <div className="workspace" id="workspace">
        <section className="panel" aria-labelledby="workflow-title">
          <div className="panel-top"><h2 id="workflow-title">Verification workspace</h2><button className="text-button" disabled={busy} onClick={useExample}>Load example ↗</button></div>
          <div className="tabs" aria-label="Workspace actions">
            <button className={pane === 'verify' ? 'selected' : ''} aria-pressed={pane === 'verify'} disabled={busy} onClick={() => setPane('verify')}>Verify a merge</button>
            <button className={pane === 'policy' ? 'selected' : ''} aria-pressed={pane === 'policy'} disabled={busy} onClick={() => setPane('policy')}>Register policy</button>
          </div>
          <form onSubmit={runAction}>
            <fieldset disabled={busy || Boolean(pending)}>
              {pane === 'verify' ? <>
                <label>Policy ID<input value={policyId} onChange={event => changeProof(setPolicyId, event.target.value)} required maxLength={300} spellCheck={false} /></label>
                <label>Merge commit SHA<input value={sha} onChange={event => changeProof(setSha, event.target.value)} required maxLength={40} spellCheck={false} /></label>
                <div className="input-row">
                  <label>Pull request<input value={pull} onChange={event => setPull(event.target.value)} inputMode="numeric" maxLength={16} required /></label>
                  <label>Workflow run<input value={run} onChange={event => setRun(event.target.value)} inputMode="numeric" maxLength={16} required /></label>
                  <label>Attempt<input value={attempt} onChange={event => setAttempt(event.target.value)} inputMode="numeric" maxLength={16} required /></label>
                </div>
              </> : <>
                <label>GitHub repository<input placeholder="owner/repository" value={repo} onChange={event => setRepo(event.target.value)} maxLength={140} required /></label>
                <label>Repository ID<input value={repoId} onChange={event => setRepoId(event.target.value)} inputMode="numeric" maxLength={16} required /></label>
                <div className="input-row two">
                  <label>Target branch<input value={branch} onChange={event => setBranch(event.target.value)} maxLength={100} required /></label>
                  <label>Required workflow ID<input value={workflow} onChange={event => setWorkflow(event.target.value)} inputMode="numeric" maxLength={16} required /></label>
                </div>
                <p className="hint">Use the numeric repository and workflow IDs from the GitHub API. <a href={repository + '#create-a-policy'} target="_blank" rel="noreferrer">Find the IDs ↗</a></p>
              </>}
            </fieldset>
            <div className="actions">
              <button type="submit" className="button primary" disabled={!address || busy || Boolean(pending) || connecting}>
                {busy ? 'Transaction in progress' : !walletAddress ? 'Connect wallet' : pane === 'policy' ? 'Register on GenLayer' : 'Verify on GenLayer'}
              </button>
              {pane === 'verify' && <button type="button" className="button secondary" disabled={checking || busy || !policyId.trim() || !shaPattern.test(sha.trim().toLowerCase())}
                onClick={() => void lookup(policyId.trim(), sha.trim().toLowerCase())}>Look up approval</button>}
              {pending && !busy && <button type="button" className="button secondary" onClick={() => void resume()}>Resume tracking</button>}
            </div>
          </form>
          <div className="feedback" aria-live="polite">
            {phase && <p className="phase"><i className={busy ? 'pulse' : ''} />{phase}</p>}
            {transactionHash && <a href={explorer + '/tx/' + transactionHash} target="_blank" rel="noreferrer">Transaction {short(transactionHash)} ↗</a>}
            {message && <p>{message}</p>}
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        </section>
        <section className="panel approval" aria-labelledby="approval-title">
          <div className="panel-top"><h2 id="approval-title">Approval record</h2>{approval && <span className="badge">Finalized</span>}</div>
          {approval ? <>
            <div className="stamp"><span aria-hidden="true">✓</span> Approved release</div>
            <p className="repo">{approval.policy.repo}<span>{approval.policy.branch}</span></p>
            <dl className="facts">
              <div><dt>Merge commit</dt><dd><a href={gh(approval.policy.repo) + '/commit/' + approval.sha} target="_blank" rel="noreferrer">{short(approval.sha, 12)} ↗</a></dd></div>
              <div><dt>Pull request</dt><dd><a href={gh(approval.policy.repo) + '/pull/' + approval.pull} target="_blank" rel="noreferrer">#{approval.pull} ↗</a></dd></div>
              <div><dt>Workflow attempt</dt><dd><a href={gh(approval.policy.repo) + '/actions/runs/' + approval.run + '/attempts/' + approval.attempt} target="_blank" rel="noreferrer">{approval.run} / {approval.attempt} ↗</a></dd></div>
              <div><dt>Pinned workflow</dt><dd>{approval.policy.workflow_id}</dd></div>
              <div><dt>Evidence digest</dt><dd className="digest">{approval.digest}</dd></div>
            </dl>
            <div className="actions result-actions">
              <button className="button secondary" onClick={() => void copyApproval()}>Copy approval link</button>
              {loadedExample && deployment.approvalTx && <a className="button secondary" href={explorer + '/tx/' + deployment.approvalTx} target="_blank" rel="noreferrer">Finalized receipt ↗</a>}
            </div>
          </> : <div className="empty">
            <p aria-live="polite">{loadState}</p>
            {policy && <p className="repo">{policy.repo}<span>{policy.branch}</span></p>}
            <p>Every approval binds a repository, branch and workflow to a specific merge SHA.</p>
          </div>}
        </section>
      </div>
      <aside className="info" aria-label="Deployment details">
        <div><strong>Chain {chain.id}</strong><p>{counts ? `${counts.policies} registered · ${counts.approvals} approvals` : network}</p></div>
        <div><strong>Authority</strong><p>Public GitHub REST data, independently checked by GenLayer validators.</p></div>
        <div><strong>Contract</strong><p>{address ? <a href={explorer + '/address/' + address} target="_blank" rel="noreferrer">{short(address)} ↗</a> : 'Address pending'}</p></div>
      </aside>
    </main>
    <footer className="wrap"><span>MergeWitness</span><a href={repository} target="_blank" rel="noreferrer">Source and review guide ↗</a></footer>
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
