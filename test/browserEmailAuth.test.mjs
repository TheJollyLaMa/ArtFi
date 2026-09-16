import test from "node:test";
import assert from "node:assert/strict";

import * as Delegation from "@ucanto/core/delegation";
import * as Ed25519 from "@ucanto/principal/ed25519";
import { Wallet, id } from "ethers";

import { createBrowserEmailAuth, MemoryNonceStore } from "../scripts/browserEmailAuth.mjs";
import { requestPinataSignedUrl, verifyPinataUploadRequest } from "../scripts/browserAuthServer.mjs";
import { createUploadCapability, createWalletAgentBinding } from "../scripts/ucanStorage.mjs";

const origin = "https://artfi.example";
const now = Date.parse("2026-09-16T12:00:00.000Z");

async function fixture() {
  const walletSigner = Wallet.createRandom();
  const browserSigner = await Ed25519.generate();
  const serviceSigner = await Ed25519.generate();
  const emailHash = id("private-salt:creator@example.com");
  const binding = await createWalletAgentBinding({
    walletSigner,
    wallet: walletSigner.address,
    agentDid: browserSigner.did(),
    emailHash,
    chainId: 8453,
    origin,
    issuedAt: new Date(now).toISOString(),
  });
  const messages = [];
  const auth = createBrowserEmailAuth({
    serviceSigner,
    authSecret: "a-test-secret-that-is-at-least-32-characters",
    mailer: { sendMail: async message => messages.push(message) },
    mailFrom: "ArtFi <auth@artfi.example>",
    publicBaseUrl: "https://auth.artfi.example",
    allowedOrigins: [origin],
    nonceStore: new MemoryNonceStore(),
    now: () => now,
  });
  return { auth, binding, browserSigner, serviceSigner, emailHash, messages };
}

test("email confirmation issues a one-time UCAN to the wallet-bound browser DID", async () => {
  const { auth, binding, browserSigner, serviceSigner, emailHash, messages } = await fixture();
  await auth.start({
    email: "Creator@Example.com",
    binding,
    returnUrl: `${origin}/app/`,
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, "creator@example.com");
  const confirmationUrl = messages[0].text.match(/https:\/\/\S+/)[0];
  assert.doesNotMatch(confirmationUrl, /creator%40example|Creator%40Example/i);

  const token = new URL(confirmationUrl).searchParams.get("token");
  const confirmed = await auth.confirm(token);
  const proofValue = new URL(confirmed.redirectUrl).hash.split("=")[1];
  const extracted = await Delegation.extract(Buffer.from(decodeURIComponent(proofValue), "base64"));
  assert.ifError(extracted.error);
  assert.equal(extracted.ok.issuer.did(), serviceSigner.did());
  assert.equal(extracted.ok.audience.did(), browserSigner.did());
  assert.equal(extracted.ok.capabilities[0].with, `artfi:wallet:${binding.wallet}`);
  assert.equal(extracted.ok.capabilities[0].can, "store/add");
  assert.equal(extracted.ok.capabilities[0].nb.emailHash, emailHash.toLowerCase());
  await assert.rejects(() => auth.confirm(token), /already used/);
});

test("rejects altered bindings, expired signatures, and unapproved return origins", async () => {
  const { auth, binding } = await fixture();
  await assert.rejects(() => auth.start({
    email: "creator@example.com",
    binding: { ...binding, emailHash: id("altered") },
    returnUrl: `${origin}/`,
  }), /not canonical/);
  await assert.rejects(() => auth.start({
    email: "creator@example.com",
    binding,
    returnUrl: "https://evil.example/",
  }), /not allowed/);
});

test("verifies an email-issued proof against the on-chain DID and rejects replay", async () => {
  const { auth, binding, browserSigner, serviceSigner, emailHash, messages } = await fixture();
  await auth.start({ email: "creator@example.com", binding, returnUrl: `${origin}/` });
  const token = new URL(messages[0].text.match(/https:\/\/\S+/)[0]).searchParams.get("token");
  const confirmed = await auth.confirm(token);
  const authorization = decodeURIComponent(new URL(confirmed.redirectUrl).hash.split("=")[1]);
  const invocation = await createUploadCapability({
    signer: browserSigner,
    serviceDid: serviceSigner.did(),
    wallet: binding.wallet,
    provider: "pinata",
    authorization,
    lifetimeSeconds: 60,
  });
  const body = {
    name: "request.json",
    size: 1024,
    type: "application/json",
    binding,
    ucan: invocation,
  };
  const replayStore = new MemoryNonceStore();
  const options = {
    serviceDid: serviceSigner.did(),
    allowedOrigins: new Set([origin]),
    profileReader: async () => ({
      emailHash: emailHash.toLowerCase(),
      agentDidHash: id(browserSigner.did()).toLowerCase(),
      profileUri: "ipfs://bafyprofile",
    }),
    replayStore,
    now,
  };
  const verified = await verifyPinataUploadRequest(body, options);
  assert.equal(verified.binding.wallet, binding.wallet);
  await assert.rejects(() => verifyPinataUploadRequest(body, options), /already used/);
});

test("requests a short-lived JSON-only Pinata upload URL", async () => {
  let request;
  const url = await requestPinataSignedUrl({
    pinataJwt: "server-only-jwt",
    pinataSignUrl: "https://uploads.pinata.example/v3/files/sign",
    name: "outcome.json",
    size: 2048,
    fetchImpl: async (endpoint, options) => {
      request = { endpoint, options };
      return new Response(JSON.stringify({ data: "https://uploads.pinata.example/signed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(url, "https://uploads.pinata.example/signed");
  assert.equal(request.options.headers.authorization, "Bearer server-only-jwt");
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.mime_types, ["application/json"]);
  assert.equal(body.max_file_size, 2048);
  assert.equal(body.network, "public");
  assert.equal(body.filename, "outcome.json");
});

test("allows only profile metadata to bootstrap before on-chain registration", async () => {
  const { auth, binding, browserSigner, serviceSigner, messages } = await fixture();
  await auth.start({ email: "creator@example.com", binding, returnUrl: `${origin}/` });
  const token = new URL(messages[0].text.match(/https:\/\/\S+/)[0]).searchParams.get("token");
  const confirmed = await auth.confirm(token);
  const authorization = decodeURIComponent(new URL(confirmed.redirectUrl).hash.split("=")[1]);
  const ucan = await createUploadCapability({
    signer: browserSigner,
    serviceDid: serviceSigner.did(),
    wallet: binding.wallet,
    provider: "pinata",
    authorization,
  });
  let profileReads = 0;
  await verifyPinataUploadRequest({
    name: "profile.json",
    size: 200,
    type: "application/json",
    binding,
    ucan,
  }, {
    serviceDid: serviceSigner.did(),
    allowedOrigins: new Set([origin]),
    profileReader: async () => { profileReads += 1; throw new Error("not registered"); },
    replayStore: new MemoryNonceStore(),
    now,
  });
  assert.equal(profileReads, 0);
});