const fs = require('fs');
const path = require('path');
const { Contract, Interface, JsonRpcProvider, getAddress, id, ZeroHash } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const ACCOUNTS_PATH = path.join(ROOT, 'contributor-accounts.json');
const DEFAULT_RPC = 'https://base-rpc.publicnode.com';

const ROUTER_ABI = [
  'function contributors(address) view returns (bytes32 githubIdHash, bool approved, bool exists)',
  'function allContributorWallets() view returns (address[])',
  'function setContributorsApproved(address[] wallets, bytes32[] githubIdHashes, bool[] approvals)',
];

// Must match the dapp's contributorIdHash: keccak256(utf8(githubLogin)).
function githubIdHash(login) {
  return id(String(login));
}

function readDesiredWhitelist() {
  const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  const contributors = Array.isArray(parsed.contributors) ? parsed.contributors : [];
  const desired = new Map();
  for (const contributor of contributors) {
    const login = String(contributor.github || '').trim();
    const wallet = String(contributor.walletAddress || '').trim();
    if (!login || !wallet) continue;
    const checksummed = getAddress(wallet);
    const existing = desired.get(checksummed.toLowerCase());
    if (existing && existing.github !== login) {
      throw new Error(`Wallet ${checksummed} is claimed by both @${existing.github} and @${login}`);
    }
    desired.set(checksummed.toLowerCase(), {
      github: login,
      wallet: checksummed,
      githubIdHash: githubIdHash(login),
    });
  }
  return desired;
}

async function readOnChainWhitelist(router) {
  const wallets = await router.allContributorWallets();
  const onChain = new Map();
  for (const wallet of wallets) {
    const record = await router.contributors(wallet);
    onChain.set(wallet.toLowerCase(), {
      wallet: getAddress(wallet),
      githubIdHash: record.githubIdHash,
      approved: record.approved,
    });
  }
  return onChain;
}

function diffWhitelists(desired, onChain) {
  const toApprove = [];
  const toRevoke = [];
  const hashMismatches = [];

  for (const [key, entry] of desired) {
    const current = onChain.get(key);
    if (!current || !current.approved) {
      toApprove.push(entry);
    } else if (current.githubIdHash !== entry.githubIdHash) {
      hashMismatches.push({ ...entry, onChainHash: current.githubIdHash });
    }
  }

  for (const [key, current] of onChain) {
    if (current.approved && !desired.has(key)) toRevoke.push(current);
  }

  return { toApprove, toRevoke, hashMismatches };
}

function buildCalldata({ toApprove, toRevoke, hashMismatches }) {
  const wallets = [];
  const hashes = [];
  const approvals = [];

  for (const entry of [...toApprove, ...hashMismatches]) {
    wallets.push(entry.wallet);
    hashes.push(entry.githubIdHash);
    approvals.push(true);
  }
  for (const entry of toRevoke) {
    wallets.push(entry.wallet);
    hashes.push(ZeroHash);
    approvals.push(false);
  }

  if (wallets.length === 0) return null;
  const iface = new Interface(ROUTER_ABI);
  return {
    wallets,
    hashes,
    approvals,
    calldata: iface.encodeFunctionData('setContributorsApproved', [wallets, hashes, approvals]),
  };
}

async function main() {
  const command = process.argv[2] || 'verify';
  const routerAddress = String(process.env.ARTFI_SETTLEMENT_ROUTER_ADDRESS || '').trim();
  const desired = readDesiredWhitelist();

  console.log(`GitHub whitelist (contributor-accounts.json): ${desired.size} wallet(s)`);
  for (const entry of desired.values()) {
    console.log(`  @${entry.github.padEnd(20)} ${entry.wallet}  ${entry.githubIdHash}`);
  }

  if (!routerAddress) {
    console.log('\nARTFI_SETTLEMENT_ROUTER_ADDRESS is not set, so no on-chain comparison was made.');
    const plan = buildCalldata({ toApprove: [...desired.values()], toRevoke: [], hashMismatches: [] });
    if (plan) {
      console.log('\nsetContributorsApproved arguments for a fresh deployment:');
      console.log(`  wallets:   ${JSON.stringify(plan.wallets)}`);
      console.log(`  hashes:    ${JSON.stringify(plan.hashes)}`);
      console.log(`  approvals: ${JSON.stringify(plan.approvals)}`);
      console.log(`\ncalldata: ${plan.calldata}`);
    }
    return;
  }

  const provider = new JsonRpcProvider(process.env.BASE_RPC_URL || DEFAULT_RPC, 8453, { batchMaxCount: 1 });
  const router = new Contract(getAddress(routerAddress), ROUTER_ABI, provider);
  const onChain = await readOnChainWhitelist(router);
  const diff = diffWhitelists(desired, onChain);

  console.log(`\nOn-chain whitelist (${routerAddress}): ${[...onChain.values()].filter(e => e.approved).length} approved wallet(s)`);

  if (!diff.toApprove.length && !diff.toRevoke.length && !diff.hashMismatches.length) {
    console.log('\n✅ The GitHub whitelist and the contract whitelist match.');
    return;
  }

  for (const entry of diff.toApprove) console.log(`  + approve  @${entry.github} ${entry.wallet}`);
  for (const entry of diff.toRevoke) console.log(`  - revoke   ${entry.wallet} (not in contributor-accounts.json)`);
  for (const entry of diff.hashMismatches) {
    console.log(`  ~ rehash   @${entry.github} ${entry.wallet} on-chain=${entry.onChainHash} expected=${entry.githubIdHash}`);
  }

  const plan = buildCalldata(diff);
  if (plan && command === 'plan') {
    console.log('\nsetContributorsApproved arguments:');
    console.log(`  wallets:   ${JSON.stringify(plan.wallets)}`);
    console.log(`  hashes:    ${JSON.stringify(plan.hashes)}`);
    console.log(`  approvals: ${JSON.stringify(plan.approvals)}`);
    console.log(`\ncalldata: ${plan.calldata}`);
  } else if (plan) {
    console.log('\nRun "npm run whitelist:plan" to print the transaction arguments and calldata.');
  }

  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { readDesiredWhitelist, diffWhitelists, buildCalldata, githubIdHash };
