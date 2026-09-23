# ArtFi

![ArtFi branding](https://github.com/user-attachments/assets/58069599-d5d0-4bf3-a066-a2ac34234ff8)

Zero-to-no-profit micro-liquidity protocol for Artizen creators. 
Automated grant advances, human-in-the-loop onboarding, and smart contract settlement.

## Base deployment

ArtFi will operate on **Base** ...

$ART - `0x44c4516768e47cd97cfF2561B81a74699F23f8Ec`

... and currently uses the `$ART` token for payroll bot to help us get ArtFi started with a micro-economic spark!

Need an advance? Attend all the quests and classes to show you're accountable and then use your boost points and Art tokens for access to loans from last season's successful creators according to your project momentum.  Once you've shown you're slightly accountable, access to offers will appear from creators who have a little extra to lend some cash in exchange for a similar portion of your seasonal payout to get you by until then.  Read the TERMS!  They are meant to be simple and inviting while still offering a basic guideline for the mercy and generosity of a sponsor. 

First season newcomers only!
- meant for newcomers to have an easier time with the anticipation phase until their first payout while coming in hungry from the cold ...
- introduces the community to new ways we can extend/receive agency to/from each other across borders with web3 tools, software, and frame of mind.

## On-chain advance protocol

`ArtFiProtocol` is the deployable escrow/NFT contract, `ArtFiNetworkRegistry` is the separate serverless CID discovery and node-reward registry, and `ArtFiSettlementRouter` is the isolated payroll/project treasury. Together they combine request discovery, sponsor escrow, receivable ownership, settlement, outcome attestations, participant history, community replication, and accountable payroll without an ArtFi-owned database.

### NFT lifecycle

1. A creator links a browser UCAN agent to their wallet, then registers the agent DID hash, an email hash made with a private high-entropy salt, and an IPFS profile URI. Plaintext email, salt, and private agent key never go on-chain.
2. The creator uploads validated request metadata to Pinata or IPFS Desktop, then mints a non-transferable request NFT containing its `ipfs://` URI plus the asset, principal, repayment, deadlines, terms hash, and canonical Artizen project and fund links.
3. A registered sponsor uploads offer metadata and funds the request with native currency or an administrator-approved ERC-20. Funding mints one offer NFT representing the sponsor's receivable.
4. The creator accepts before the funding deadline. Request NFTs stay with their creators; offer NFTs can transfer only while an advance is active and only to another registered profile.
5. Direct repayment and settlement payout recovery follow the current offer NFT owner. That owner may designate a recipient contract or wallet; transferring the NFT clears that destination.
6. The original NFT pair remains after repayment, settlement, cancellation, expiry, or default. Each final participant may submit one immutable IPFS outcome document, updating only their corresponding NFT URI while the rating, hash, CID, participant, and timestamp remain on-chain.

Both final participants may submit one permanent 1-5 rating with a content hash and IPFS evidence URI. An `OutcomeFinalized` event is emitted when both sides have submitted. Wallet and salted-email-hash indexes retain request, funding, borrowing, repayment, recovery, payout, default, and outcome totals per asset.

Rich NFT data is provider-neutral IPFS content. The dapp supports local IPFS Desktop uploads and Pinata through a server-issued short-lived upload URL; Pinata credentials are never exposed to the browser. Email confirmation delegates upload capability to that browser's UCAN agent, while wallet transactions remain authoritative for contract actions. Sensitive attachments can be encrypted locally before upload; public NFT metadata remains intentionally public. See [docs/IPFS_UCAN.md](docs/IPFS_UCAN.md).

### Asset and escrow safety

- The zero address identifies native currency; every ERC-20 must be explicitly approved by an administrator.
- ERC-20 paths use `SafeERC20` and reject fee-on-transfer behavior. Native transfers use checked calls.
- `totalLiabilities(asset)` tracks funded principal still held in escrow. An asset cannot be disabled while it backs escrow.
- Administrators may recover only balances above recorded liabilities. There is no unrestricted drain.
- Repayment fees remain capped at 5% of principal. State changes precede external transfers and all value-moving entry points are reentrancy guarded.

The settlement role is trusted to report the correct gross payout. A short payout closes the advance as defaulted rather than preserving indefinite debt. Terms and outcome documents remain on IPFS, while their hashes, CIDs, canonical Artizen links, and financial results are anchored on-chain.

`repaymentDueAt` is visible evidence of timeliness rather than a hard payment cutoff: creators may repay late until the settlement role closes the advance. This preserves a voluntary cure path while the recorded due date, close time, and final status make lateness inspectable. Cancelled and expired offers remain in NFT history but are not counted as completed loans because principal was never disbursed.

### Local validation

```bash
npm test
npm run test:storage
```

The deployment script reads optional `ADMIN_ADDRESS`, `ART_TOKEN_ADDRESS`, and comma-separated `SUPPORTED_ASSETS`. Native currency is enabled by default. The script deploys `ArtFiProtocol`, then `ArtFiNetworkRegistry` with the protocol address, then `ArtFiSettlementRouter` with the administrator. Configured ERC-20 assets are approved in both contracts, and the initial `artfi-repo-dev` settlement fund is created.

### Settlement router and payroll fund

`ArtFiSettlementRouter` keeps payroll funds isolated by `(fundId, asset)`. The initial fund is:

```text
fundId: artfi-repo-dev
asset: ART
purpose: contributor payroll for reviewed repository work
```

The router rejects duplicate issue/PR work references within a fund and emits a `PayrollPaid` ledger event containing the recipient, asset, amount, repository/contributor hashes, work reference, and metadata evidence. Recovery can only withdraw contract-level excess; allocated fund balances remain protected.

Set `ARTFI_SETTLEMENT_ROUTER_ADDRESS` after deployment. Fund `artfi-repo-dev` with ART before enabling payroll settlement. The payroll UI must wait for the router transaction receipt before the off-chain queue is marked settled.

### First network bootstrap

After deployment, keep the deployed contract addresses in `.env` as `ARTFI_PROTOCOL_ADDRESS` and `ARTFI_NETWORK_REGISTRY_ADDRESS`. Do not commit `.env`.

Check that both deployed addresses have code and that the configured signer can reach them:

```bash
npm run network:verify
```

Generate the two `bytes32` values needed to register a local IPFS Desktop/Kubo node:

```bash
npm run network:node-hashes
```

Copy `nodeDidHash` and `peerIdHash` into the IPFS storage panel, or register from the terminal:

```bash
ARTFI_NODE_DID_HASH=0x... \
ARTFI_PEER_ID_HASH=0x... \
npm run network:register-node
```

The administrator wallet must approve the new node before heartbeats count:

```bash
ARTFI_NODE_ID=1 npm run network:approve-node
```

Set the current monthly challenge:

```bash
ARTFI_NETWORK_MONTH=202609 npm run network:set-challenge
```

Once a profile and request metadata CID exist, publish the CID into the serverless registry and mint the request NFT:

```bash
ARTFI_CONTENT_KIND=request \
ARTFI_CONTENT_CID=ipfs://... \
ARTFI_CONTENT_FILE=request.json \
ARTFI_PROJECT_URL=https://... \
ARTFI_FUND_URL=https://... \
npm run network:publish-content

ARTFI_REQUEST_AMOUNT=100 \
ARTFI_REQUEST_METADATA_URI=ipfs://... \
ARTFI_PROJECT_URL=https://... \
ARTFI_FUND_URL=https://... \
npm run network:create-request
```

Rebuild the local read-only ledger view for the UI:

```bash
npm run index:network
```

## Payroll bounty labels

ArtFi payroll automation now recognizes **$ART-only** payout labels on GitHub issues.

- Contributor payout label format: `bounty: <amount> ART` (the `$` before `ART` is optional)
- Testing payout label format: `test-bounty: <amount> ART` (the `$` before `ART` is optional)
- Idea originator format: `idea-credit: @username`

Examples:

- `bounty: 25 ART`
- `bounty: 100 ART`
- `bounty: 0.5 USDC`
- `test-bounty: 10 ART`
- `idea-credit: @octocat`

The merge bot runs only when a PR is merged into `main`; closing a PR without merging it never creates a payout automatically. Link the issue with `Closes #123` in the PR body, reference `#123` in the title, or use GitHub's Development sidebar. The bot checks the PR author and issue assignees against `contributor-accounts.json`, then records valid entries with `currency: "ART"` in `payroll-queue.json` for administrator review.

When an exact `idea-credit: @username` label is present, the bounty is split 80% to the whitelisted implementer and 20% to the whitelisted idea originator. A generic `idea-credit` label does not identify a payable originator and therefore does not trigger a split.

## Whitelist requests

People can request whitelist access through the GitHub issue form at **Issues → New issue → Whitelist Request**. The form captures:

- GitHub username
- email for follow-up
- wallet address
- desired role
- contribution summary

When a whitelist request issue is opened, the repo sends an admin email using the configured SMTP secrets. The email includes the request details and a direct link to the issue so the admin can approve the wallet and add them to `contributor-accounts.json`.

To enable email delivery, set these repository secrets:

- `WHITELIST_REQUEST_TO`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

For work intentionally closed without merge, or for an older PR that was not linked correctly, run **Actions → Bounty Bot → Run workflow** with the PR number and optional issue number. Testing bounties use `/test-complete` from an assigned tester followed by `/test-approved` from the repository owner. Finalized payments are moved from pending to settled through **Actions → Settle Payroll**.

The Pages payroll admin panel can select one or more creators and submit their pending ART totals one creator at a time through the current settlement router. Wait for each transaction to confirm, then run **Settle Payroll** with the selected comma-separated GitHub handles. For distinct transaction hashes, provide matching `creator=transaction-hash` pairs in the `tx_hashes` input; a failed creator remains pending and can be retried without disturbing successful creators.

