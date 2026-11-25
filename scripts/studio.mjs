import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createAccount, createClient } from 'genlayer-js';
import { studionet, studioDevnet } from 'genlayer-js/chains';
import { TransactionHashVariant } from 'genlayer-js/types';
import { getAddress } from 'viem';

const example = JSON.parse(await readFile('deployments/example.json', 'utf8'));
const path = 'deployments/studio.json';
const manifest = JSON.parse(await readFile(path, 'utf8'));
const chain = manifest.chainId === studionet.id ? studionet : studioDevnet;
assert.equal(chain.id, manifest.chainId);
const reader = createClient({ chain });
const source = (await readFile('contracts/merge_witness.py', 'utf8')).replaceAll('\r\n', '\n');
const digest = value => createHash('sha256').update(value).digest('hex');
const policy = [example.repo, example.repositoryId, example.branch, example.workflowId];
const policyId = policy.join(':');
const verify = run => [policyId, example.pull, run, example.attempt, example.sha];
const view = (address, functionName, args = []) => reader.readContract({
  address, functionName, args, transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
});
const journalPath = '.studio-state/studio-run.json';
let stage = 'preflight';
const save = (file, object) => writeFile(file, JSON.stringify(object, null, 2) + '\n');

async function indexed(read) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return await read(); } catch { await delay(2000); }
  }
  throw new Error('Finalized state not available');
}

function finalized(receipt, reject) {
  assert.equal(receipt.statusName, 'FINALIZED');
  assert.equal(receipt.result_name, 'MAJORITY_AGREE');
  assert.notEqual(receipt.leader_only, true);
  assert.equal(receipt.txExecutionResultName, reject ? 'FINISHED_WITH_ERROR' : 'FINISHED_WITH_RETURN');
  if (reject) assert.ok(JSON.stringify(receipt.consensus_data?.leader_receipt ?? []).includes(reject));
}

async function check(record) {
  stage = 'verify deployed source';
  assert.equal(record.sourceSha256, digest(source));
  await indexed(async () => assert.equal(digest(await reader.getContractCode(record.address)), record.sourceSha256));
  stage = 'verify approval';
  const proof = await indexed(async () => JSON.parse(String(await view(record.address, 'get_approval', [policyId, example.sha]))));
  const { digest: proofDigest, policy: savedPolicy, ...fields } = proof;
  assert.equal(savedPolicy.id, policyId);
  assert.equal(fields.pull, example.pull);
  assert.equal(fields.run, example.run);
  assert.equal(fields.attempt, example.attempt);
  assert.equal(fields.sha, example.sha);
  assert.match(proofDigest, /^[a-f0-9]{64}$/);
  assert.equal(await view(record.address, 'is_approved', [policyId, example.sha]), true);
  for (const [name, reject] of [['deploymentTx'], ['policyTx'], ['approvalTx'], ['wrongWorkflowTx', 'MW_WRONG_WORKFLOW']]) {
    stage = name;
    finalized(await indexed(() => reader.getTransaction({ hash: record[name] })), reject);
  }
  console.log(JSON.stringify({ chain: chain.id, address: record.address, proofDigest, writes: 0 }));
  return proof;
}

async function deploy(resume) {
  assert.equal(existsSync(journalPath), resume, 'Use --resume only for an existing transaction journal');
  const account = createAccount();
  const client = createClient({ chain, account });
  const record = resume ? JSON.parse(await readFile(journalPath, 'utf8'))
    : { chainId: chain.id, sourceSha256: digest(source), deployer: account.address };
  assert.equal(record.chainId, chain.id);
  assert.equal(record.sourceSha256, digest(source));
  const quote = await client.estimateTransactionFees({
    leaderTimeunitsAllocation: 100n, validatorTimeunitsAllocation: 200n,
    rotations: [3n], appealRounds: 0n, totalMessageFees: 0n,
  });
  assert.ok(quote.feeValue <= 110_000_000_000_000_000n);
  const fees = { distribution: quote.distribution, feeValue: quote.feeValue };
  if (!record.approvalTx) {
    stage = 'test faucet';
    await client.request({ method: 'sim_fundAccount', params: [account.address, 1_000_000_000_000_000_000] });
  }
  await mkdir('.studio-state', { recursive: true });
  async function send(name, submit, reject) {
    stage = name;
    const hash = record[name] ?? await submit();
    if (!record[name]) {
      record[name] = hash;
      await save(journalPath, record);
    }
    console.log(JSON.stringify({ stage, hash }));
    let receipt;
    for (let retry = 0; retry < 75; retry++) {
      try { receipt = await reader.getTransaction({ hash }); }
      catch { /* A submitted hash can take time to appear. */ }
      if (receipt?.statusName === 'FINALIZED' || receipt?.statusName === 'CANCELED') break;
      await delay(5000);
    }
    assert.ok(receipt, 'No receipt for submitted transaction');
    console.log(JSON.stringify({ stage, status: receipt.statusName, execution: receipt.txExecutionResultName, consensus: receipt.result_name }));
    if (receipt.txExecutionResultName === 'FINISHED_WITH_ERROR') {
      const codes = [...new Set((JSON.stringify(receipt.consensus_data?.leader_receipt) ?? '').match(/MW_[A-Z_]+/g))];
      console.log(JSON.stringify({ stage, codes }));
    }
    finalized(receipt, reject);
    return receipt;
  }
  const receipt = await send('deploymentTx', () => client.deployContract({
    code: Buffer.from(source), args: [], fees, leaderOnly: false,
  }));
  record.address = getAddress(receipt.data?.contract_address ?? receipt.txDataDecoded?.contractAddress);
  await save(journalPath, record);
  await indexed(async () => assert.equal(digest(await reader.getContractCode(record.address)), record.sourceSha256));
  console.log(JSON.stringify({ address: record.address }));
  const write = (functionName, args) => client.writeContract({ address: record.address, functionName, args, value: 0n, fees, leaderOnly: false });
  await send('policyTx', () => write('register_policy', policy));
  await indexed(async () => assert.equal(JSON.parse(String(await view(record.address, 'get_policy', [policyId]))).id, policyId));
  await send('wrongWorkflowTx', () => write('verify_merge', verify(example.otherWorkflowRun)), 'MW_WRONG_WORKFLOW');
  if (!record.approvalTx) assert.equal(await view(record.address, 'is_approved', [policyId, example.sha]), false);
  await send('approvalTx', () => write('verify_merge', verify(example.run)));
  record.approval = await check(record);
  record.checkedAt = new Date().toISOString();
  await save(path, record);
}

console.error = () => {};
try {
  assert.equal(Number(await reader.getChainId()), manifest.chainId);
  if (process.argv.includes('--deploy')) await deploy(false);
  else if (process.argv.includes('--resume')) await deploy(true);
  else await check(manifest);
} catch (error) {
  let root = error;
  for (let i = 0; i < 10 && root?.cause; i++) root = root.cause;
  console.log(JSON.stringify({ stage, error: error.name, code: root?.code, database: /database/i.test(String(error)),
    assertion: error.name === 'AssertionError' ? String(error.message).slice(0, 240) : undefined }));
  process.exitCode = 1;
}
