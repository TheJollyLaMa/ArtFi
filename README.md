# ArtFi

ArtFi is a simple soft-launch micro-liquidity layer for Artizen newcomers.

The core idea is straightforward: if someone is waiting for their first Artizen payout, they can post a request for ART (or another approved asset) with clear repayment terms. Another wallet can offer to fund it under those terms. Until that happens, or instead of it, people can also earn ART directly by contributing repo work or by running an IPFS node.

There are no boost points or off-chain credits in ArtFi. Everything is either a request/offer you fund on-chain, or ART you earn directly from a settlement fund.

## The short version

There are two practical ways to earn ART today:

1. Post a request and get it filled
   - A newcomer posts a request specifying the asset, principal amount, repayment amount, and deadlines.
   - Another wallet reviews those terms and funds the request as an offer.
   - The request and offer are escrowed, settled, and recorded on-chain.
   - This is the centerpiece of ArtFi: a newcomer does not have to wait in limbo for their first Artizen payout.

2. Earn ART directly from the network
   - Do repo work and claim a `bounty:` or `test-bounty:` labeled issue; payment comes from the `artfi-repo-dev` fund allocation.
   - Run and register an IPFS/Kubo node; payment comes from the `node-reward-fund` allocation once you pass checker spot-checks.

## Ways to earn tokens

### A. Request + offer flow

This is the main on-ramp for new Artizen participants.

- A creator posts a request: asset, principal, repayment amount, funding deadline, and repayment due date.
- A sponsor reviews those terms and funds the request, which mints their offer NFT.
- Funds are held in escrow until repayment or settlement.
- Repayment or settlement is recorded on-chain against the original request and offer.

This is the path for “I need a little runway on clear terms while I wait for my first real Artizen payout.”

### B. Repo and issue work

The payroll bot recognizes labels like:

- `bounty: 25 ART`
- `bounty: 100 ART`
- `test-bounty: 10 ART`
- `idea-credit: @username`

If a PR is merged into `main` and linked to the issue, the payout is queued from the `artfi-repo-dev` settlement fund for administrator review.

### C. IPFS node rewards

If you run a Kubo/IPFS node and register it through the ArtFi network registry:

- you must register the node and get admin approval
- the node must pass 25 independent checker spot-checks in a month
- once eligible, a configured ART reward is paid from the `node-reward-fund` allocation

This is the “keep the decent-artizen data alive” path for people who want to help power the network without needing an immediate funding request.

## Getting started today

### 1) Install and configure

```bash
npm install
cp .env.example .env
```

Fill in the essentials in `.env`:

- `ADMIN_ADDRESS`
- `ARTFI_PROTOCOL_ADDRESS`
- `ARTFI_NETWORK_REGISTRY_ADDRESS`
- `ARTFI_SETTLEMENT_ROUTER_ADDRESS`
- `ART_TOKEN_ADDRESS`

### 2) Deploy the contracts

Use the deployment script to deploy the three core contracts:

```bash
npx hardhat run scripts/deploy.js --network base
```

This deploys:

- `ArtFiProtocol`
- `ArtFiNetworkRegistry`
- `ArtFiSettlementRouter`

### 3) Configure the router and rewards

After deploy:

- approve supported ERC-20 assets
- create the settlement fund, typically `artfi-repo-dev`
- fund the router fund with ART or the approved asset
- grant the Registry the router `PAYROLL_ROLE`
- approve recipient wallets on the router

### 4) Register and run a node (optional, but recommended)

Generate the required node hashes and register the node:

```bash
npm run network:node-hashes
npm run network:register-node
```

After admin approval, participate in the monthly reward flow:

```bash
ARTFI_NETWORK_MONTH=202609 npm run network:set-challenge
npm run index:network
```

### 5) Run the tests

```bash
npm test
```

## Soft launch note

ArtFi is ready for a soft launch with our first small group of participants.

It is intentionally simple:

- people can request ART on clear terms while waiting for a first Artizen payout
- people can earn ART directly through repo work or by running node infrastructure
- the protocol keeps requests, offers, and payouts transparent and auditable on-chain

The point is not perfection; it is to get the first 12 people moving, earning, and connected without friction.

If you are one of the first 12, start with one of these:

- post a request with your terms (asset, amount, repayment, deadline)
- review an open request and fund it as an offer
- claim a `bounty:` or `test-bounty:` labeled issue
- register an IPFS node and help keep the data layer alive

That is enough to get going today.

