import test from "node:test";
import assert from "node:assert/strict";
import { delegate } from "@ucanto/core";
import * as Delegation from "@ucanto/core/delegation";
import * as Ed25519 from "@ucanto/principal/ed25519";

import {
  createOfferMetadata,
  createOutcomeMetadata,
  createProfileMetadata,
  createRequestMetadata,
  decryptPrivateMetadata,
  encodeMetadata,
  encryptPrivateMetadata,
  requireIpfsUri,
} from "../scripts/ipfsMetadata.mjs";
import {
  createIpfsDesktopUploader,
  createPinataUploader,
  createUploadCapability,
  createWalletAgentBinding,
} from "../scripts/ucanStorage.mjs";

const wallet = "0x1111111111111111111111111111111111111111";
const emailHash = `0x${"ab".repeat(32)}`;
const creator = {
  wallet,
  agentDid: "did:key:z6MkCreator",
  profileUri: "ipfs://bafycreatorprofile",
  artizenProfileUrl: "https://artizen.fund/profile/creator",
};
const common = {
  artizenProjectUrl: "https://artizen.fund/index/p/project",
  artizenFundUrl: "https://artizen.fund/index/f/fund",
  creator,
};

async function emailAuthorization({ browserSigner, serviceSigner, provider = "pinata" }) {
  const proof = await delegate({
    issuer: serviceSigner,
    audience: browserSigner,
    capabilities: [{
      with: `artfi:wallet:${wallet}`,
      can: "store/add",
      nb: { provider, emailHash, origin: "https://artfi.example" },
    }],
    expiration: Math.floor(Date.now() / 1000) + 3600,
  });
  const archived = await Delegation.archive(proof);
  if (archived.error) throw archived.error;
  return Buffer.from(archived.ok).toString("base64");
}

test("builds portable profile, request, offer, and outcome metadata", () => {
  const profile = createProfileMetadata(creator);
  const request = createRequestMetadata({
    ...common,
    name: "Request #1",
    description: "Advance request",
    asset: "0x0000000000000000000000000000000000000000",
    principal: "100",
    repaymentAmount: "104",
    fundingDeadline: 1000,
    repaymentDueAt: 2000,
    termsHash: "0xabc",
  });
  const offer = createOfferMetadata({
    ...common,
    name: "Offer #1",
    requestUri: "ipfs://bafyrequest",
    sponsor: { ...creator, wallet: "0x2222222222222222222222222222222222222222" },
    termsHash: "0xabc",
  });
  const outcome = createOutcomeMetadata({
    ...common,
    name: "Outcome #1",
    requestUri: "ipfs://bafyrequest",
    offerUri: "ipfs://bafyoffer",
    participant: creator,
    status: "Repaid",
    rating: 5,
    result: "Both parties would work together again.",
  });

  for (const document of [profile, request, offer, outcome]) {
    assert.equal(document.schema, "https://artfi.example/schemas/advance-metadata-v1.json");
    assert.match(new TextDecoder().decode(encodeMetadata(document)), /artizen\.fund/);
  }
  assert.equal(request.artizenProjectUrl, common.artizenProjectUrl);
  assert.equal(request.artizenFundUrl, common.artizenFundUrl);
  assert.equal(offer.sponsor.wallet, "0x2222222222222222222222222222222222222222");
  assert.equal(outcome.rating, 5);
});

test("rejects metadata without required Artizen links or portable IPFS URIs", () => {
  assert.throws(() => createRequestMetadata({ ...common, artizenProjectUrl: "http://example.com" }), /HTTPS/);
  assert.throws(() => requireIpfsUri("https://gateway.example/ipfs/bafy"), /ipfs:\/\//);
  assert.throws(() => createOutcomeMetadata({ ...common, rating: 6 }), /rating/);
});

test("creates a short-lived UCAN upload capability bound to wallet and provider", async () => {
  const signer = await Ed25519.generate();
  const service = await Ed25519.generate();
  const archive = await createUploadCapability({
    signer,
    serviceDid: service.did(),
    wallet,
    provider: "pinata",
    authorization: await emailAuthorization({ browserSigner: signer, serviceSigner: service }),
    lifetimeSeconds: 60,
  });
  assert.ok(archive.length > 100);
});

test("binds a browser agent DID to the connected wallet with a signed statement", async () => {
  const signed = [];
  const binding = await createWalletAgentBinding({
    walletSigner: { signMessage: async message => { signed.push(message); return "0xsigned"; } },
    wallet,
    agentDid: "did:key:z6MkBrowser",
    emailHash,
    chainId: 8453,
    origin: "https://artfi.example",
    issuedAt: "2026-09-16T00:00:00.000Z",
  });
  assert.equal(binding.signature, "0xsigned");
  assert.match(binding.message, /Agent: did:key:z6MkBrowser/);
  assert.match(signed[0], /Chain ID: 8453/);
});

test("uploads through a Pinata signed URL without exposing a JWT", async () => {
  const signer = await Ed25519.generate();
  const service = await Ed25519.generate();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/pinata-upload-url") {
      return new Response(JSON.stringify({ url: "https://uploads.pinata.example/signed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ IpfsHash: "bafypinata" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const upload = createPinataUploader({
    signingEndpoint: "/api/pinata-upload-url",
    serviceDid: service.did(),
    fetchImpl,
  });
  const binding = { wallet, signature: "0xsigned" };
  const authorization = await emailAuthorization({ browserSigner: signer, serviceSigner: service });
  const uri = await upload({
    bytes: new TextEncoder().encode("{}"),
    name: "request.json",
    wallet,
    signer,
    binding,
    authorization,
  });
  assert.equal(uri, "ipfs://bafypinata");
  assert.equal(calls.length, 2);
  const signingRequest = JSON.parse(calls[0].options.body);
  assert.match(signingRequest.ucan, /^[A-Za-z0-9+/=]+$/);
  assert.equal(signingRequest.binding.signature, "0xsigned");
});

test("uploads to the local IPFS Desktop API and returns a provider-neutral URI", async () => {
  let requestedUrl;
  const upload = createIpfsDesktopUploader({
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ Hash: "bafylocal" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const uri = await upload({ bytes: new TextEncoder().encode("{}"), name: "offer.json" });
  assert.equal(uri, "ipfs://bafylocal");
  assert.match(requestedUrl, /^http:\/\/127\.0\.0\.1:5001\/api\/v0\/add/);
});

test("encrypts sensitive attachments before upload without placing the key in IPFS content", async () => {
  const privateData = { email: "creator@example.com", negotiationNotes: "Private draft terms" };
  const encrypted = await encryptPrivateMetadata(privateData);
  assert.equal(encrypted.document.kind, "encrypted-attachment");
  assert.equal(JSON.stringify(encrypted.document).includes(privateData.email), false);
  assert.equal(JSON.stringify(encrypted.document).includes(encrypted.key), false);
  assert.deepEqual(await decryptPrivateMetadata(encrypted.document, encrypted.key), privateData);
});
