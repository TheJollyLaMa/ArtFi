const { ethers, network } = require("hardhat");

const ROUTER = process.env.ARTFI_SETTLEMENT_ROUTER_ADDRESS;

const TOKENS = {
  ART: { address: "0x44c4516768e47cd97cfF2561B81a74699F23f8Ec", decimals: 18 },
  BNUT: { address: "0x25ACb773159Af5a5c672DEfe31C7Fff6a9A93736", decimals: 18 },
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
};

const FUNDS = [
  {
    id: "artfi-repo-dev",
    metadataUri: "ipfs://bafyartfirepodevfundmetadata000000000000000001",
    allocations: { ART: "300", BNUT: "1000", USDC: "0.5" },
  },
  {
    id: "bignuten-repo-dev",
    metadataUri: "ipfs://bafkreib6tsoxhmjrl6etnf6t2rt2swwgptrvjtcvrnh2uozjnqxafagzzy",
    allocations: { ART: "210", BNUT: "1008", USDC: "0.5" },
  },
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

function requiredTotals() {
  const totals = {};
  for (const fund of FUNDS) {
    for (const [symbol, amount] of Object.entries(fund.allocations)) {
      const units = ethers.parseUnits(amount, TOKENS[symbol].decimals);
      totals[symbol] = (totals[symbol] || 0n) + units;
    }
  }
  return totals;
}

async function main() {
  if (!ROUTER) throw new Error("Set ARTFI_SETTLEMENT_ROUTER_ADDRESS in .env");
  const apply = process.argv.includes("--apply");
  const [signer] = await ethers.getSigners();
  const router = await ethers.getContractAt("ArtFiSettlementRouter", ROUTER, signer);

  console.log(`Router ${ROUTER} v${await router.VERSION()} on ${network.name}`);
  console.log(`Signer ${signer.address}`);
  console.log(apply ? "MODE: apply\n" : "MODE: dry run (pass --apply to broadcast)\n");

  const accounts = require("../contributor-accounts.json");
  const contributors = (accounts.contributors || [])
    .filter(entry => entry.github && entry.walletAddress)
    .map(entry => ({
      github: entry.github,
      wallet: ethers.getAddress(entry.walletAddress),
      githubIdHash: ethers.id(entry.github),
    }));

  const plan = [];
  const send = async (label, execute) => {
    plan.push(label);
    if (!apply) return;
    const tx = await execute();
    await tx.wait();
    console.log(`   confirmed ${tx.hash}`);
  };

  for (const contributor of contributors) {
    if (await router.isApprovedRecipient(contributor.wallet)) continue;
    console.log(`whitelist @${contributor.github} ${contributor.wallet}`);
    await send(`whitelist @${contributor.github}`, () =>
      router.setContributorApproved(contributor.wallet, contributor.githubIdHash, true)
    );
  }

  for (const [symbol, token] of Object.entries(TOKENS)) {
    if (await router.approvedAssets(token.address)) continue;
    console.log(`approve asset ${symbol} ${token.address}`);
    await send(`approve ${symbol}`, () => router.setAssetApproved(token.address, true));
  }

  for (const fund of FUNDS) {
    const fundId = ethers.id(fund.id);
    const existing = await router.funds(fundId);
    if (!existing.exists) {
      console.log(`create fund ${fund.id}`);
      await send(`create fund ${fund.id}`, () => router.createFund(fundId, fund.metadataUri));
    } else if (!existing.active) {
      console.log(`reactivate fund ${fund.id}`);
      await send(`reactivate ${fund.id}`, () => router.setFundActive(fundId, true));
    }
  }

  const totals = requiredTotals();
  for (const [symbol, total] of Object.entries(totals)) {
    const token = new ethers.Contract(TOKENS[symbol].address, ERC20_ABI, signer);
    const balance = await token.balanceOf(signer.address);
    const decimals = TOKENS[symbol].decimals;
    console.log(`${symbol}: need ${ethers.formatUnits(total, decimals)}, wallet holds ${ethers.formatUnits(balance, decimals)}`);
    if (balance < total) throw new Error(`Insufficient ${symbol}: need ${ethers.formatUnits(total, decimals)}`);
    if ((await token.allowance(signer.address, ROUTER)) >= total) continue;
    await send(`approve ${symbol} spend`, () => token.approve(ROUTER, total));
  }

  for (const fund of FUNDS) {
    const fundId = ethers.id(fund.id);
    for (const [symbol, amount] of Object.entries(fund.allocations)) {
      const token = TOKENS[symbol];
      const target = ethers.parseUnits(amount, token.decimals);
      const current = await router.fundBalances(fundId, token.address);
      if (current >= target) continue;
      const missing = target - current;
      console.log(`fund ${fund.id} with ${ethers.formatUnits(missing, token.decimals)} ${symbol}`);
      await send(`fund ${fund.id} ${symbol}`, () => router.fundToken(fundId, token.address, missing));
    }
  }

  console.log(`\n${plan.length} transaction(s) ${apply ? "sent" : "planned"}:`);
  plan.forEach((label, index) => console.log(`  ${index + 1}. ${label}`));
  if (!apply && plan.length) console.log("\nRe-run with --apply to broadcast.");
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
