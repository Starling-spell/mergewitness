import { createClient } from 'genlayer-js';
import { studionet, studioDevnet } from 'genlayer-js/chains';
import { TransactionHashVariant, type Hash } from 'genlayer-js/types';
import { getAddress } from 'viem';
import deployment from '../deployments/studio.json';

export type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: () => void): void;
  removeListener?(event: string, handler: () => void): void;
};
declare global { interface Window { ethereum?: Provider } }

export type Policy = { id: string; repo: string; repository_id: number; branch: string; workflow_id: number };
export type Approval = {
  policy: Policy; sha: string; pull: number; run: number; attempt: number;
  merged_at: string; run_started_at: string; digest: string;
};
export type Counts = { policies: number | bigint; approvals: number | bigint };
export type ContractArgs = (string | number)[];

export const chain = deployment.chainId === 61999 ? studionet : studioDevnet;
export const network = chain.id === 61999 ? 'GenLayer Studio' : 'GenLayer Studio Next';
export const explorer = chain.id === 61999 ? 'https://explorer-studio.genlayer.com' : 'https://explorer-studio-dev.genlayer.com';
export const rpc = chain.rpcUrls.default.http[0];
export const address = deployment.address ? getAddress(deployment.address) : undefined;
export const reader = createClient({ chain });
export const repository = 'https://github.com/Starling-spell/mergewitness';
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function read(functionName: string, args: ContractArgs = []) {
  if (!address) throw new Error('This build has no contract address.');
  return reader.readContract({ address, functionName, args, transactionHashVariant: TransactionHashVariant.LATEST_FINAL });
}

export async function jsonView<T>(functionName: string, args: ContractArgs): Promise<T | null> {
  const value = await read(functionName, args);
  return value ? JSON.parse(String(value)) as T : null;
}

export async function wallet(prompt = true) {
  const provider = window.ethereum;
  if (!provider) throw new Error('WALLET_MISSING');
  const accounts = await provider.request({ method: prompt ? 'eth_requestAccounts' : 'eth_accounts' }) as string[];
  if (!accounts?.[0]) throw new Error('WALLET_CONNECT');
  return { provider, account: getAddress(accounts[0]) };
}

export async function submit(functionName: string, args: ContractArgs): Promise<Hash> {
  if (!address) throw new Error('This build has no contract address.');
  const { provider, account } = await wallet(false);
  const chainId = '0x' + chain.id.toString(16);
  if (Number(await provider.request({ method: 'eth_chainId' })) !== chain.id) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    } catch (error) {
      if ((error as {code?: number}).code !== 4902) throw error;
      await provider.request({ method: 'wallet_addEthereumChain', params: [{
        chainId, chainName: network, rpcUrls: [rpc], blockExplorerUrls: [explorer],
        nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
      }] });
    }
  }
  if (Number(await provider.request({ method: 'eth_chainId' })) !== chain.id) throw new Error('WRONG_NETWORK');
  const client = createClient({ chain, account, provider });
  const quote = await client.estimateTransactionFees({
    leaderTimeunitsAllocation: 100n, validatorTimeunitsAllocation: 200n,
    rotations: [3n], appealRounds: 0n, totalMessageFees: 0n,
  });
  return client.writeContract({
    address, functionName, args, value: 0n, leaderOnly: false,
    fees: { distribution: quote.distribution, feeValue: quote.feeValue },
  });
}

const reasons: Record<string, string> = {
  MW_UNKNOWN_POLICY: 'That policy has not been registered.',
  MW_PR_UNAVAILABLE: 'GitHub did not return a readable public pull request. Check the number and try again later.',
  MW_PR_IDENTITY: 'The pull request does not belong to the policy repository.',
  MW_PR_TARGET: 'The pull request targets a different branch or repository.',
  MW_PR_NOT_MERGED: 'GitHub does not show this pull request as merged.',
  MW_MERGE_SHA_MISMATCH: 'The commit SHA does not match the merged pull request.',
  MW_CI_UNAVAILABLE: 'GitHub did not return that public workflow attempt. Check the run and attempt numbers.',
  MW_CI_IDENTITY: 'The run or attempt belongs to a different repository or fork.',
  MW_WRONG_WORKFLOW: 'The run uses a different workflow than the one pinned by this policy.',
  MW_CI_TARGET: 'The run must be triggered by a push to the policy branch.',
  MW_CI_SHA_MISMATCH: 'The workflow ran on a different commit.',
  MW_CI_PENDING: 'The workflow attempt has not completed.',
  MW_CI_NOT_SUCCESS: 'The workflow attempt did not conclude successfully.',
  MW_INVALID_PROOF: 'Enter valid pull request, run and attempt numbers and a full commit SHA.',
  MW_INVALID_REPO: 'Enter a valid GitHub owner and repository.',
  MW_INVALID_BRANCH: 'Enter a valid branch name.',
  MW_INVALID_ID: 'Enter positive repository and workflow IDs.',
};

export function receiptFailure(data: unknown) {
  const code = JSON.stringify(data)?.match(/MW_[A-Z_]+/)?.[0];
  return code && reasons[code] ? reasons[code] : 'The transaction finalized without a successful contract result.';
}

export function walletError(error: unknown) {
  const text = String(error);
  if (/WALLET_MISSING/.test(text)) return 'Install an injected wallet such as MetaMask to submit a transaction.';
  if (/WALLET_CONNECT/.test(text)) return 'Connect your wallet before submitting.';
  if (/WRONG_NETWORK/.test(text)) return `Switch your wallet to ${network} (${chain.id}).`;
  if (/4001|rejected|denied/i.test(text)) return 'You declined the wallet request.';
  if (/insufficient|balance/i.test(text)) return 'Get test GEN from the Studio faucet, then try again.';
  return 'The network or wallet could not complete the request. Check the connection and try again.';
}
