import { delegate } from "@ucanto/core";
import * as Delegation from "@ucanto/core/delegation";
import { Verifier } from "@ucanto/principal";
import * as Ed25519 from "@ucanto/principal/ed25519";

const DATABASE_NAME = "artfi-browser-agent";
const STORE_NAME = "keys";
const AGENT_KEY = "ed25519";
const EMAIL_SALT_KEY = "email-salt";
const EMAIL_AUTHORIZATION_KEY = "email-authorization";

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function openDatabase(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl) throw new Error("IndexedDB is required for browser-agent persistence");
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DATABASE_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
  });
}

async function readStoredKey(indexedDBImpl) {
  const database = await openDatabase(indexedDBImpl);
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(AGENT_KEY);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  }).finally(() => database.close());
}

async function storeKey(value, indexedDBImpl) {
  const database = await openDatabase(indexedDBImpl);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, AGENT_KEY);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = resolve;
  }).finally(() => database.close());
}

function randomHex(bytes = 32, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.getRandomValues) throw new Error("Web Crypto is required");
  const value = cryptoImpl.getRandomValues(new Uint8Array(bytes));
  return `0x${[...value].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function loadOrCreateBrowserAgent({ indexedDBImpl } = {}) {
  const stored = await readStoredKey(indexedDBImpl);
  if (stored) return Ed25519.decode(base64ToBytes(stored));
  const signer = await Ed25519.generate();
  await storeKey(bytesToBase64(Ed25519.encode(signer)), indexedDBImpl);
  return signer;
}

export async function loadOrCreateEmailSalt({ indexedDBImpl, cryptoImpl } = {}) {
  const stored = await readStoredKeyByName(EMAIL_SALT_KEY, indexedDBImpl);
  if (stored) return stored;
  const salt = randomHex(32, cryptoImpl);
  await storeKeyByName(EMAIL_SALT_KEY, salt, indexedDBImpl);
  return salt;
}

async function readStoredKeyByName(name, indexedDBImpl) {
  const database = await openDatabase(indexedDBImpl);
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  }).finally(() => database.close());
}

async function storeKeyByName(name, value, indexedDBImpl) {
  const database = await openDatabase(indexedDBImpl);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, name);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = resolve;
  }).finally(() => database.close());
}

export async function storeEmailAuthorization(value, { indexedDBImpl, expectedAudience } = {}) {
  const extracted = await Delegation.extract(base64ToBytes(value));
  if (extracted.error) throw extracted.error;
  if (expectedAudience && extracted.ok.audience.did() !== expectedAudience) {
    throw new Error("Email authorization belongs to a different browser agent");
  }
  await storeKeyByName(EMAIL_AUTHORIZATION_KEY, value, indexedDBImpl);
  return extracted.ok;
}

export async function loadEmailAuthorization({ indexedDBImpl } = {}) {
  return readStoredKeyByName(EMAIL_AUTHORIZATION_KEY, indexedDBImpl);
}

export async function consumeEmailAuthorizationFromLocation({
  signer,
  locationImpl = globalThis.location,
  historyImpl = globalThis.history,
  indexedDBImpl,
} = {}) {
  const match = String(locationImpl?.hash || "").match(/^#artfi-email-auth=(.+)$/);
  if (!match) return null;
  const archive = decodeURIComponent(match[1]);
  await storeEmailAuthorization(archive, { indexedDBImpl, expectedAudience: signer?.did() });
  historyImpl?.replaceState?.(null, "", `${locationImpl.pathname || "/"}${locationImpl.search || ""}`);
  return archive;
}

export async function requestEmailAuthorization({
  endpoint = "/api/browser-auth/start",
  email,
  binding,
  returnUrl = globalThis.location?.href,
  fetchImpl = globalThis.fetch,
}) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, binding, returnUrl }),
  });
  if (!response.ok) throw new Error(`Email authorization failed (${response.status})`);
  return response.json();
}

export async function createUploadCapability({
  signer,
  serviceDid,
  wallet,
  provider,
  authorization,
  lifetimeSeconds = 300,
}) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error("wallet must be an Ethereum address");
  if (!['pinata', 'ipfs-desktop'].includes(provider)) throw new Error("provider is not supported");
  if (!authorization) throw new Error("Email authorization is required");
  const extracted = await Delegation.extract(base64ToBytes(authorization));
  if (extracted.error) throw extracted.error;
  const proof = extracted.ok;
  if (proof.issuer.did() !== serviceDid) throw new Error("Authorization issuer does not match service DID");
  if (proof.audience.did() !== signer.did()) throw new Error("Authorization belongs to another browser agent");
  if (proof.expiration <= Math.floor(Date.now() / 1000)) throw new Error("Email authorization has expired");
  const allowed = proof.capabilities.some(capability =>
    capability.can === "store/add" &&
    capability.with === `artfi:wallet:${wallet.toLowerCase()}` &&
    capability.nb?.provider === provider
  );
  if (!allowed) throw new Error("Email authorization does not permit this upload");
  const delegation = await delegate({
    issuer: signer,
    audience: Verifier.parse(serviceDid),
    capabilities: [{
      with: `artfi:wallet:${wallet.toLowerCase()}`,
      can: "store/add",
      nb: { provider },
    }],
    proofs: [proof],
    expiration: Math.floor(Date.now() / 1000) + lifetimeSeconds,
  });
  const archived = await Delegation.archive(delegation);
  if (archived.error) throw archived.error;
  return bytesToBase64(archived.ok);
}

export async function createWalletAgentBinding({
  walletSigner,
  wallet,
  agentDid,
  emailHash,
  chainId,
  origin = globalThis.location?.origin || "unknown",
  issuedAt = new Date().toISOString(),
}) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error("wallet must be an Ethereum address");
  if (!String(agentDid).startsWith("did:key:")) throw new Error("agentDid must be a did:key identifier");
  if (!/^0x[a-fA-F0-9]{64}$/.test(emailHash)) throw new Error("emailHash must be bytes32");
  const message = [
    "ArtFi browser authorization",
    `Wallet: ${wallet.toLowerCase()}`,
    `Agent: ${agentDid}`,
    `Email commitment: ${emailHash.toLowerCase()}`,
    `Chain ID: ${chainId}`,
    `Origin: ${origin}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");
  return {
    wallet: wallet.toLowerCase(),
    agentDid,
    emailHash: emailHash.toLowerCase(),
    chainId: String(chainId),
    origin,
    issuedAt,
    message,
    signature: await walletSigner.signMessage(message),
  };
}

export function createPinataUploader({ signingEndpoint, serviceDid, fetchImpl = globalThis.fetch }) {
  if (!signingEndpoint) throw new Error("Pinata signing endpoint is required");
  return async function upload({ bytes, name, wallet, signer, binding, authorization }) {
    if (!binding || binding.wallet !== wallet.toLowerCase()) throw new Error("Wallet-agent binding is required");
    const ucan = await createUploadCapability({
      signer,
      serviceDid,
      wallet,
      provider: "pinata",
      authorization,
    });
    const signingResponse = await fetchImpl(signingEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, size: bytes.byteLength, type: "application/json", binding, ucan }),
    });
    if (!signingResponse.ok) throw new Error(`Pinata signing failed (${signingResponse.status})`);
    const { url } = await signingResponse.json();
    if (!url) throw new Error("Pinata signing response did not include a URL");

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/json" }), name);
    form.append("network", "public");
    const response = await fetchImpl(url, { method: "POST", body: form });
    if (!response.ok) throw new Error(`Pinata upload failed (${response.status})`);
    const result = await response.json();
    const cid = result.IpfsHash || result.cid || result.data?.cid;
    if (!cid) throw new Error("Pinata upload response did not include a CID");
    return `ipfs://${cid}`;
  };
}

export function createDirectPinataUploader({ jwt, apiUrl = "https://uploads.pinata.cloud/v3/files" } = {}) {
  if (!jwt) throw new Error("A Pinata JWT is required for direct upload");
  return async function upload({ bytes, name }) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/json" }), name);
    form.append("network", "public");
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
    if (!response.ok) throw new Error(`Pinata upload failed (${response.status})`);
    const result = await response.json();
    const cid = result.data?.cid || result.cid || result.IpfsHash;
    if (!cid) throw new Error("Pinata response did not include a CID");
    return `ipfs://${cid}`;
  };
}

export function createIpfsDesktopUploader({ apiUrl = "http://127.0.0.1:5001", fetchImpl = globalThis.fetch } = {}) {
  return async function upload({ bytes, name }) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/json" }), name);
    const endpoint = `${apiUrl.replace(/\/$/, "")}/api/v0/add?cid-version=1&pin=true`;
    const response = await fetchImpl(endpoint, { method: "POST", body: form });
    if (!response.ok) throw new Error(`IPFS Desktop upload failed (${response.status})`);
    const result = await response.json();
    const cid = result.Hash || result.cid;
    if (!cid) throw new Error("IPFS Desktop response did not include a CID");
    return `ipfs://${cid}`;
  };
}
