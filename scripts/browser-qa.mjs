import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createAccount, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { keccak256 } from 'viem';

const production = 'https://mergewitness.vercel.app';
const rpc = studionet.rpcUrls.default.http[0];
const explorer = 'https://explorer-studio.genlayer.com';
const deployment = JSON.parse(await readFile('deployments/studio.json', 'utf8'));
const sample = JSON.parse(await readFile('deployments/example.json', 'utf8'));
const proof = deployment.approval;
const storeKey = 'mergewitness:' + deployment.chainId + ':' + deployment.address;
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  headless: true,
});
const liveWallet = process.argv.includes('--live-wallet');
const local = process.argv.includes('--local');
const check = name => console.log('PASS ' + name);

async function open(page) {
  if (local) {
    await page.route(production + '/**', async route => {
      const path = new URL(route.request().url()).pathname.slice(1) || 'index.html';
      if (!/^(index\.html|logo\.png|assets\/[\w.-]+\.(js|css))$/.test(path)) {
        await route.abort();
        return;
      }
      const body = await readFile('dist/' + path);
      const contentType = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css'
        : path.endsWith('.png') ? 'image/png' : 'text/html';
      await route.fulfill({ body, contentType });
    });
  }
  const result = await page.goto(production, { waitUntil: 'domcontentloaded' });
  assert.equal(result?.status(), 200);
  await page.getByRole('heading', { name: 'Prove what passed.' }).waitFor();
}

async function checkApproval(page, live = true) {
  await page.getByText(proof.digest, { exact: true }).waitFor();
  await page.getByText(live ? 'Finalized' : 'Recorded receipt', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Finalized receipt' }).getAttribute('href'), explorer + '/tx/' + deployment.approvalTx);
  assert.equal(await page.getByRole('link', { name: 'Wrong-workflow rejection' }).getAttribute('href'), explorer + '/tx/' + deployment.wrongWorkflowTx);
}

try {
  for (const width of [375, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.name));
    await open(page);
    await checkApproval(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width === 375) {
      await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
      await page.getByRole('alert').getByText(/Install an injected wallet/).waitFor();
    }
    if (width === 1440) {
      const sha = page.getByLabel('Merge commit SHA');
      await sha.fill('a'.repeat(40));
      await page.getByRole('button', { name: 'Look up approval' }).click();
      await page.getByText(/has no finalized approval/).waitFor();
      await sha.fill('invalid');
      assert.equal(await page.getByRole('button', { name: 'Look up approval' }).isEnabled(), false);
      await page.getByRole('button', { name: 'Load example' }).click();
      await checkApproval(page);
    }
    assert.deepEqual(errors, []);
    await page.close();
    check('anonymous live approval and layout at ' + width + 'px');
  }

  const offline = await browser.newPage();
  await offline.route(rpc, route => route.abort());
  await open(offline);
  await checkApproval(offline, false);
  await offline.getByText(/Live Studio lookup unavailable/).waitFor();
  await offline.close();
  check('RPC failure shows the recorded receipt with an explicit label');

  // Reopen both real finalized receipts without submitting additional transactions.
  for (const [hash, expected] of [
    [deployment.approvalTx, 'approved'],
    [deployment.wrongWorkflowTx, 'rejected'],
  ]) {
    const resumed = await browser.newPage();
    await resumed.addInitScript(({ key, record }) => localStorage.setItem(key, JSON.stringify(record)), {
      key: storeKey, record: { hash, policy: proof.policy.id, sha: proof.sha, kind: 'verify' },
    });
    await open(resumed);
    await resumed.getByRole('button', { name: 'Resume tracking' }).click();
    if (expected === 'approved') {
      await resumed.getByText(/verification transaction finalized successfully/).waitFor();
      await checkApproval(resumed);
    } else {
      await resumed.getByRole('alert').getByText(/different workflow than the one pinned/).waitFor();
    }
    assert.equal(await resumed.evaluate(key => localStorage.getItem(key), storeKey), null);
    assert.ok(await resumed.locator(`a[href="${explorer}/tx/${hash}"]`).first().isVisible());
    await resumed.close();
    check('real finalized ' + expected + ' receipt resumes and clears pending state');
  }

  if (liveWallet) {
    assert.equal(deployment.chainId, studionet.id);
    const account = createAccount();
    const client = createClient({ chain: studionet, account });
    const chainHex = '0x' + studionet.id.toString(16);
    assert.equal(Number(await client.getChainId()), deployment.chainId);
    await client.request({ method: 'sim_fundAccount', params: [account.address, 1_000_000_000_000_000_000] });
    let mode = 'deny';
    const submitted = [];
    const signedPage = await browser.newPage();
    await signedPage.exposeBinding('qaSendStudioTransaction', async ({ frame }, tx) => {
      assert.equal(new URL(frame.url()).origin, production);
      assert.equal(tx.from.toLowerCase(), account.address.toLowerCase());
      assert.equal(tx.to.toLowerCase(), studionet.consensusMainContract.address.toLowerCase());
      assert.equal(tx.chainId, chainHex);
      assert.ok(tx.data.toLowerCase().includes(deployment.address.slice(2).toLowerCase()));
      const value = BigInt(tx.value);
      assert.ok(value >= 0n && value <= 110_000_000_000_000_000n);
      assert.ok(submitted.length < 3);
      if (mode === 'deny') return { denied: true };
      const raw = await account.signTransaction({
        to: tx.to, data: tx.data, value, nonce: Number(BigInt(tx.nonce)),
        gas: BigInt(tx.gas), gasPrice: BigInt(tx.gasPrice), chainId: deployment.chainId, type: 'legacy',
      });
      const hash = keccak256(raw);
      console.log(JSON.stringify({ signed: hash }));
      // A transport retry sends the identical signed bytes and cannot create a second transaction.
      for (let retry = 0; ; retry++) {
        try {
          assert.equal(await client.sendRawTransaction({ serializedTransaction: raw }), hash);
          break;
        } catch (error) {
          const existing = await client.getTransaction({ hash }).catch(() => undefined);
          if (existing?.statusName) break;
          if (retry === 2) throw error;
          await delay(2000);
        }
      }
      submitted.push(hash);
      console.log(JSON.stringify({ broadcast: hash }));
      return { hash };
    });
    await signedPage.addInitScript(({ account, chainHex }) => {
      let currentChain = '0x1';
      let added = false;
      window.ethereum = { request: async ({ method, params }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
        if (method === 'eth_chainId') return currentChain;
        if (method === 'wallet_addEthereumChain') { added = true; return null; }
        if (method === 'wallet_switchEthereumChain') {
          if (!added) throw Object.assign(new Error('Unknown chain'), { code: 4902 });
          if (params[0].chainId !== chainHex) throw new Error('Unexpected chain');
          currentChain = chainHex; return null;
        }
        if (method === 'eth_sendTransaction') {
          const result = await window.qaSendStudioTransaction(params[0]);
          if (result.denied) throw Object.assign(new Error('User rejected request'), { code: 4001 });
          return result.hash;
        }
        throw new Error('Unexpected wallet method: ' + method);
      }};
    }, { account: account.address, chainHex });
    await open(signedPage);
    await signedPage.getByRole('button', { name: 'Verify on GenLayer' }).click();
    await signedPage.getByRole('alert').getByText('You declined the wallet request.').waitFor();
    assert.equal(submitted.length, 0);
    check('wallet adds and explicitly switches networks, with a clean rejection state');

    mode = 'send';
    await signedPage.getByRole('button', { name: 'Register policy', exact: true }).click();
    await signedPage.getByLabel('GitHub repository').fill(sample.repo);
    await signedPage.getByLabel('Repository ID').fill(String(sample.repositoryId));
    await signedPage.getByLabel('Target branch').fill(sample.branch);
    await signedPage.getByLabel('Required workflow ID').fill(String(sample.workflowId));
    await signedPage.getByRole('button', { name: 'Register on GenLayer' }).click();
    await signedPage.waitForFunction(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.hash, storeKey);
    await signedPage.reload({ waitUntil: 'domcontentloaded' });
    await signedPage.getByRole('button', { name: 'Resume tracking' }).click();
    await signedPage.getByText(/Policy registered/).waitFor({ timeout: 180000 });
    assert.equal(await signedPage.getByLabel('Policy ID').inputValue(), proof.policy.id);
    assert.equal(submitted.length, 1);
    check('live policy registration survives reload and resumes without double submission');

    await signedPage.getByLabel('Workflow run').fill(String(sample.otherWorkflowRun));
    await signedPage.getByRole('button', { name: 'Verify on GenLayer' }).click();
    const alert = signedPage.getByRole('alert');
    assert.match(await alert.innerText({ timeout: 180000 }), /different workflow than the one pinned/);
    check('live wrong-workflow denial returns its exact explanation');

    await signedPage.getByRole('button', { name: 'Load example' }).click();
    await signedPage.getByRole('button', { name: 'Verify on GenLayer' }).click();
    const success = signedPage.getByText(/verification transaction finalized successfully/);
    await success.or(alert).first().waitFor({ timeout: 180000 });
    assert.ok(await success.isVisible(), 'Verification UI error: ' + await alert.allTextContents());
    await checkApproval(signedPage);
    assert.equal(submitted.length, 3);
    assert.equal(await signedPage.evaluate(key => localStorage.getItem(key), storeKey), null);
    await signedPage.close();
    check('live valid verification finalizes and clears saved transaction');
  }
} finally {
  await browser.close();
}
