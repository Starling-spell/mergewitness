import { readFile } from 'node:fs/promises';
import { createClient } from 'genlayer-js';
import { studionet, studioDevnet } from 'genlayer-js/chains';
import { TransactionHashVariant } from 'genlayer-js/types';

const [policy, sha] = process.argv.slice(2);
if (!policy || policy.length > 300 || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
  console.error('Usage: npm run approval -- <policy-id> <lowercase-commit-sha>');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(new URL('../deployments/studio.json', import.meta.url), 'utf8'));
const chain = manifest.chainId === 61999 ? studionet : studioDevnet;
const client = createClient({ chain });
const view = functionName => client.readContract({
  address: manifest.address, functionName, args: [policy, sha],
  transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
});

try {
  if (!/^0x[0-9a-f]{40}$/i.test(manifest.address) || chain.id !== manifest.chainId ||
      Number(await client.getChainId()) !== manifest.chainId) throw new Error('Unexpected deployment');
  const approved = await view('is_approved');
  if (approved === false) {
    console.log(JSON.stringify({ approved: false, policy, sha }));
    process.exitCode = 2;
  } else {
    const record = JSON.parse(String(await view('get_approval')));
    if (approved !== true || record.policy.id !== policy || record.sha !== sha ||
        !/^[0-9a-f]{64}$/.test(record.digest)) throw new Error('Invalid finalized record');
    console.log(JSON.stringify({ approved: true, chainId: chain.id, contract: manifest.address, ...record }));
  }
} catch {
  console.error('Could not validate a finalized approval on the configured GenLayer deployment.');
  process.exitCode = 1;
}
