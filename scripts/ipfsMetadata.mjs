const SCHEMA = "https://artfi.example/schemas/advance-metadata-v1.json";
const IPFS_URI = /^ipfs:\/\/[A-Za-z0-9]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+)?$/;

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function requireHttps(value, field) {
  const url = new URL(requireText(value, field));
  if (url.protocol !== "https:") throw new Error(`${field} must use HTTPS`);
  return url.href;
}

export function requireIpfsUri(value, field = "metadataUri") {
  const uri = requireText(value, field);
  if (!IPFS_URI.test(uri)) throw new Error(`${field} must be an ipfs:// URI`);
  return uri;
}

function participant(value, field) {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  return {
    wallet: requireText(value.wallet, `${field}.wallet`),
    agentDid: requireText(value.agentDid, `${field}.agentDid`),
    profileUri: requireIpfsUri(value.profileUri, `${field}.profileUri`),
    artizenProfileUrl: requireHttps(value.artizenProfileUrl, `${field}.artizenProfileUrl`),
  };
}

function common(input) {
  return {
    schema: SCHEMA,
    artizenProjectUrl: requireHttps(input.artizenProjectUrl, "artizenProjectUrl"),
    artizenFundUrl: requireHttps(input.artizenFundUrl, "artizenFundUrl"),
    creator: participant(input.creator, "creator"),
  };
}

export function createProfileMetadata(input) {
  return {
    schema: SCHEMA,
    kind: "profile",
    wallet: requireText(input.wallet, "wallet"),
    agentDid: requireText(input.agentDid, "agentDid"),
    artizenProfileUrl: requireHttps(input.artizenProfileUrl, "artizenProfileUrl"),
  };
}

export function createRequestMetadata(input) {
  return {
    ...common(input),
    kind: "request",
    name: requireText(input.name, "name"),
    description: requireText(input.description, "description"),
    asset: requireText(input.asset, "asset"),
    principal: requireText(String(input.principal), "principal"),
    repaymentAmount: requireText(String(input.repaymentAmount), "repaymentAmount"),
    fundingDeadline: Number(input.fundingDeadline),
    repaymentDueAt: Number(input.repaymentDueAt),
    termsHash: requireText(input.termsHash, "termsHash"),
  };
}

export function createOfferMetadata(input) {
  return {
    ...common(input),
    kind: "offer",
    name: requireText(input.name, "name"),
    requestUri: requireIpfsUri(input.requestUri, "requestUri"),
    sponsor: participant(input.sponsor, "sponsor"),
    termsHash: requireText(input.termsHash, "termsHash"),
  };
}

export function createOutcomeMetadata(input) {
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error("rating must be an integer from 1 to 5");
  return {
    ...common(input),
    kind: "outcome",
    name: requireText(input.name, "name"),
    requestUri: requireIpfsUri(input.requestUri, "requestUri"),
    offerUri: requireIpfsUri(input.offerUri, "offerUri"),
    participant: participant(input.participant, "participant"),
    status: requireText(input.status, "status"),
    rating,
    result: requireText(input.result, "result"),
    transactionHash: input.transactionHash ? requireText(input.transactionHash, "transactionHash") : null,
  };
}

export function encodeMetadata(document) {
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function encryptPrivateMetadata(value, { cryptoImpl = globalThis.crypto } = {}) {
  if (!cryptoImpl?.subtle || !cryptoImpl?.getRandomValues) throw new Error("Web Crypto is required");
  const key = await cryptoImpl.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await cryptoImpl.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const exportedKey = await cryptoImpl.subtle.exportKey("raw", key);
  return {
    document: {
      schema: SCHEMA,
      kind: "encrypted-attachment",
      algorithm: "A256GCM",
      iv: toBase64Url(iv),
      ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    },
    key: toBase64Url(new Uint8Array(exportedKey)),
  };
}

export async function decryptPrivateMetadata(document, key, { cryptoImpl = globalThis.crypto } = {}) {
  if (document?.kind !== "encrypted-attachment" || document.algorithm !== "A256GCM") {
    throw new Error("Unsupported encrypted attachment");
  }
  const importedKey = await cryptoImpl.subtle.importKey(
    "raw",
    fromBase64Url(key),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await cryptoImpl.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(document.iv) },
    importedKey,
    fromBase64Url(document.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export { SCHEMA };
