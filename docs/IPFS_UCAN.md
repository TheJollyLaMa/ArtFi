# IPFS and UCAN architecture

ArtFi stores money, ownership, lifecycle state, hashes, ratings, and aggregate history on-chain. Rich profile, request, offer, and outcome documents live on IPFS and are referenced by immutable `ipfs://` URIs.

## Browser identity

Each browser creates an Ed25519 UCAN agent and stores its private key in IndexedDB for the ArtFi origin. The public agent DID is included in the user's IPFS profile document; its `keccak256` hash is registered by the user's wallet in `ArtFiProtocol.registerProfile`.

Authorization restores the useful part of the former web3.storage flow:

1. The user connects a wallet and enters an email address.
2. The browser creates or restores its local agent and a private email salt.
3. The wallet signs a canonical statement binding the wallet, browser DID, salted email commitment, chain, origin, and timestamp.
4. `POST /api/browser-auth/start` verifies the wallet signature and sends a 15-minute magic link. The address is used for delivery only and is not embedded in the link.
5. Clicking the link consumes its nonce once and delegates `store/add` from the ArtFi service DID to that browser DID for 30 days.
6. The confirmation redirects to the approved dapp URL with the archived delegation in the URL fragment. The browser validates the audience before storing it in IndexedDB.
7. Each Pinata upload uses a fresh five-minute invocation derived from that email-issued proof.

The email link must be opened in the browser being authorized because only that browser has the delegated agent's private key. Clearing site data removes both the key and proof; repeat email authorization to create a new profile binding. A deployed protocol should add an explicit profile-agent rotation transaction before supporting recovery on an existing wallet.

The wallet transaction is the binding between the wallet and browser DID. The raw email and private salt remain off-chain. Clearing site data removes the local agent key, so users should create a new profile/wallet binding rather than copying private key material between browsers.

UCAN controls off-chain upload authorization only. Wallet signatures remain mandatory for escrow, NFT ownership, repayment, settlement destinations, and outcome attestations. Pinata does not validate UCAN natively; the ArtFi auth service validates the delegation chain and then requests a short-lived Pinata upload URL.

## Metadata rules

Use `scripts/ipfsMetadata.mjs` to construct metadata before upload. Every request, offer, and outcome document must include:

- the Artizen project HTTPS URL
- the Artizen fund HTTPS URL
- creator wallet, browser DID, profile IPFS URI, and Artizen profile URL
- the request terms hash or links to the request and offer metadata, as appropriate

The request and offer NFT URIs are immutable until completion. After a terminal state, each final participant may submit exactly one outcome. The creator's outcome CID becomes the request NFT URI; the final receivable owner's outcome CID becomes the offer NFT URI. The rating, outcome hash, CID, participant, and timestamp are also retained on-chain.

IPFS metadata is presentation and evidence. Contract state remains authoritative if a gateway or pin is unavailable.

### Sensitive data

IPFS content is public to anyone who learns its CID. UCAN limits writes; it does not make a CID private. Never place plaintext email, private salts, identity documents, or sensitive negotiation notes in public NFT metadata.

`encryptPrivateMetadata` creates an AES-256-GCM encrypted attachment before upload. Its encryption key is returned separately and is never included in the IPFS document or written on-chain. Share keys out of band only with intended participants. Public NFT metadata must still contain the required Artizen project, fund, and participant links.

## IPFS Desktop

`createIpfsDesktopUploader` posts JSON to the local Kubo API at `http://127.0.0.1:5001` and pins it locally. IPFS Desktop must be running and its API CORS policy must allow the exact ArtFi origin. Keep the Kubo API bound to loopback; never expose port 5001 publicly.

The returned CID should also be pinned elsewhere when long-term availability matters. A local pin alone disappears when the user's node is offline.

## Pinata

Never place a Pinata JWT in `index.html`, browser JavaScript, Git history, or a public environment variable. `createPinataUploader` uses this flow:

1. The browser creates a five-minute `store/add` UCAN derived from its email-issued delegation and scoped to its registered wallet and the `pinata` provider.
2. It posts the invocation, fresh wallet binding, and file metadata to the ArtFi signing endpoint.
3. The endpoint verifies both UCAN signatures, delegation attenuation, expiry, capability, wallet scope, replay status, and on-chain email/DID-hash binding.
4. The endpoint uses the server-side Pinata credential to return a short-lived signed upload URL.
5. The browser uploads directly to that URL and receives a CID.

Expected signing request:

```json
{
  "network": "public",
  "filename": "request.json",
  "size": 1234,
  "mime_types": ["application/json"],
  "ucan": "base64-encoded UCAN CAR"
}
```

Expected response:

```json
{ "url": "https://uploads.pinata.cloud/..." }
```

The signing service must enforce a small JSON-only size limit, reject replayed UCAN CIDs, rate-limit each wallet, and never accept a wallet address that does not match the UCAN resource `artfi:wallet:<address>` and the on-chain `agentDidHash`.

`profile.json` is the sole bootstrap exception to the on-chain profile check: email authorization permits that first upload so its CID can be passed to `registerProfile`. Every subsequent Pinata upload requires the wallet's on-chain email commitment and browser DID hash to match.

## Running the auth service

Generate a service DID and private key once:

```bash
npm run auth:keygen
```

Store the generated values and all other secrets outside Git. Configure `.env` from `.env.example`, including SMTP, `PINATA_JWT`, the deployed protocol address, Base RPC URL, public auth URL, and exact allowed dapp origins. Then run:

```bash
npm run auth:serve
```

The service exposes:

- `POST /api/browser-auth/start`
- `GET /api/browser-auth/confirm`
- `GET /api/browser-auth/config`
- `POST /api/pinata-upload-url`
- `GET /health`

Consumed magic links and upload invocations are stored in `.data/artfi-auth-nonces.json` with mode `0600`; no email addresses are stored there. Use a shared transactional nonce store instead when deploying more than one service instance.

## Pinning portability

NFTs always store `ipfs://CID`, not a Pinata gateway URL. Pinata, IPFS Desktop, another pinning service, or any public gateway can retrieve the same content. Provider migration does not require an NFT or contract migration.

## Serverless Artizen network

ArtFi does not need to own a Pinata account or operate a storage server. Each participant can use their own Pinata account or local IPFS Desktop/Kubo node. The browser uploads the document, receives an `ipfs://CID`, and submits that CID plus its content hash in a wallet-signed transaction.

`ArtFiNetworkRegistry` is the discovery directory. Its `ContentPublished` events contain the publisher wallet, document kind, CID, content hash, browser-agent hash, and required Artizen project/fund links. An indexer can rebuild the complete directory from chain events; no ArtFi database is authoritative.

Run the portable recipe with `BASE_RPC_URL`, `ARTFI_NETWORK_REGISTRY_ADDRESS`, and an optional `ARTFI_NETWORK_FROM_BLOCK`:

```bash
BASE_RPC_URL=... \\
ARTFI_NETWORK_REGISTRY_ADDRESS=0x... \\
ARTFI_NETWORK_FROM_BLOCK=0 \\
npm run index:network
```

It writes `artizen-network-index.json`, a disposable local view. Anyone can rebuild the same view from the same chain and registry events.

### Barney-level first run

1. Install [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) or create a Pinata account.
2. If using IPFS Desktop, open **Settings → IPFS → API** and keep the API on `127.0.0.1:5001`. Allow the ArtFi site origin in Kubo CORS settings.
3. If using Pinata, create a least-privilege upload credential in your own account. Never paste it into GitHub, an NFT, or a chat message. Direct browser JWT use is a user choice with a real credential-exposure risk.
4. Open ArtFi, connect the wallet, and create the local browser agent. The private agent key stays in that browser's IndexedDB.
5. Create `profile.json`, `request.json`, `offer.json`, or `outcome.json` with `scripts/ipfsMetadata.mjs`.
6. Upload with the selected provider and copy the returned `ipfs://CID`.
7. Register or publish the CID through the wallet transaction. The registry event makes it discoverable to every indexer and node.
8. Test from another node or gateway by retrieving the CID before considering the record durable.

### Community replicas and reward pilot

Operators may run a public IPFS node that follows `ContentPublished` events, fetches the public metadata CIDs, and pins them. `ArtFiNetworkRegistry` supports an opt-in node record, administrator approval during the pilot, rotating monthly challenges, spaced heartbeats, sample-CID proof hashes, and a separate `MonthlyNodeRewardRecorded` event for the 10 ART monthly reward.

The first pilot requires 25 successful checks per month, with checks no more often than every 12 hours. The reward is recorded separately from ordinary payroll; an administrator can manually transfer 10 ART and record its transaction reference. Future work can replace manual recording with a dedicated reward treasury after anti-Sybil and geographic-independence rules are proven.

The heartbeat proves an operator responded to a current challenge and reports sample retrieval evidence; it does not claim that one node is the only copy. Multiple approved operators should pin the same public CIDs. Encrypted private attachments are excluded unless their participants explicitly authorize replication.

### Operator heartbeat command

After an administrator approves the registered node and configures the monthly challenge, run this command from the machine hosting IPFS Desktop/Kubo. Schedule it with cron, launchd, or another local task runner no more than once every 12 hours:

```bash
BASE_RPC_URL=... \\
NODE_PRIVATE_KEY=... \\
ARTFI_NETWORK_REGISTRY_ADDRESS=0x... \\
ARTFI_NODE_ID=1 \\
npm run node:heartbeat
```

By default, the keeper reads active publication CIDs from `artizen-network-index.json`, pins them through the local Kubo API, retrieves every sample CID, hashes the successful retrieval report, reads the current on-chain challenge, and submits one wallet-signed heartbeat. Keep `NODE_PRIVATE_KEY` in the node operator's local secret store; never put it in the browser or repository.

The normal operator loop is:

```bash
npm run index:network
npm run node:sample-cids
npm run node:pin-samples
npm run node:heartbeat
```

`node:sample-cids` previews the active CIDs selected from the index. `node:pin-samples` pins those CIDs locally before a heartbeat. Set `ARTFI_SAMPLE_CIDS=ipfs://bafy...,ipfs://bafy...` only when an administrator publishes a curated challenge list; otherwise the index-driven list is the least manual path.
