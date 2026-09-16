import { createServer } from "node:http";

import * as UCAN from "@ipld/dag-ucan";
import * as Delegation from "@ucanto/core/delegation";
import * as Ed25519 from "@ucanto/principal/ed25519";
import "dotenv/config";
import { Contract, JsonRpcProvider, id } from "ethers";
import nodemailer from "nodemailer";

import { createBrowserEmailAuth, FileNonceStore, verifyWalletAgentBinding } from "./browserEmailAuth.mjs";

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;
const PROFILE_ABI = [
  "function profiles(address) view returns (bytes32 emailHash, bytes32 agentDidHash, string profileUri)",
];

const decodeBase64 = value => Uint8Array.from(Buffer.from(value, "base64"));

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body, origin = "") {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
  });
  response.end(JSON.stringify(body));
}

export function createOnchainProfileReader({ rpcUrl, contractAddress }) {
  if (!rpcUrl || !contractAddress) throw new Error("RPC URL and protocol address are required");
  const contract = new Contract(contractAddress, PROFILE_ABI, new JsonRpcProvider(rpcUrl));
  return async wallet => {
    const [emailHash, agentDidHash, profileUri] = await contract.profiles(wallet);
    return { emailHash: emailHash.toLowerCase(), agentDidHash: agentDidHash.toLowerCase(), profileUri };
  };
}

export async function verifyPinataUploadRequest(body, {
  serviceDid,
  allowedOrigins,
  profileReader,
  replayStore,
  now = Date.now(),
}) {
  if (!body || body.type !== "application/json") throw new Error("Only JSON uploads are allowed");
  if (!Number.isInteger(body.size) || body.size < 1 || body.size > MAX_METADATA_BYTES) {
    throw new Error("Invalid metadata size");
  }
  if (!/^[A-Za-z0-9._-]+\.json$/.test(body.name)) throw new Error("Invalid metadata filename");
  const binding = verifyWalletAgentBinding(body.binding, { allowedOrigins, now });
  const extracted = await Delegation.extract(decodeBase64(body.ucan));
  if (extracted.error) throw extracted.error;
  const invocation = extracted.ok;
  if (invocation.issuer.did() !== binding.agentDid) throw new Error("UCAN issuer does not match browser binding");
  if (invocation.audience.did() !== serviceDid) throw new Error("UCAN audience does not match service");
  if (invocation.expiration <= Math.floor(now / 1000)) throw new Error("UCAN has expired");
  if (!(await UCAN.verifySignature(invocation.data, Ed25519.Verifier.parse(invocation.issuer.did())))) {
    throw new Error("Invalid UCAN signature");
  }
  const capability = invocation.capabilities.find(item =>
    item.can === "store/add" && item.with === `artfi:wallet:${binding.wallet}` && item.nb?.provider === "pinata"
  );
  if (!capability) throw new Error("UCAN does not permit this Pinata upload");

  const proof = invocation.proofs.find(item => typeof item === "object" && "issuer" in item);
  if (!proof) throw new Error("Email authorization proof is required");
  if (proof.issuer.did() !== serviceDid || proof.audience.did() !== binding.agentDid) {
    throw new Error("Email authorization proof does not match this browser");
  }
  if (proof.expiration <= Math.floor(now / 1000)) throw new Error("Email authorization has expired");
  if (!(await UCAN.verifySignature(proof.data, Ed25519.Verifier.parse(proof.issuer.did())))) {
    throw new Error("Invalid email authorization signature");
  }
  const delegated = proof.capabilities.find(item =>
    item.can === "store/add" &&
    item.with === `artfi:wallet:${binding.wallet}` &&
    item.nb?.provider === "pinata" &&
    String(item.nb?.emailHash || "").toLowerCase() === binding.emailHash
  );
  if (!delegated) throw new Error("Email authorization does not match this wallet");

  let profile = null;
  if (body.name !== "profile.json") {
    profile = await profileReader(binding.wallet);
    if (profile.emailHash !== binding.emailHash) throw new Error("Email commitment does not match on-chain profile");
    if (profile.agentDidHash !== id(binding.agentDid).toLowerCase()) {
      throw new Error("Browser DID does not match on-chain profile");
    }
  }
  const replayKey = invocation.cid.toString();
  if (!replayStore.consume(replayKey, invocation.expiration * 1000, now)) throw new Error("UCAN already used");
  return { binding, invocation, profile };
}

export async function requestPinataSignedUrl({ pinataJwt, pinataSignUrl, name, size, fetchImpl = fetch }) {
  if (!pinataJwt) throw new Error("PINATA_JWT is required");
  const response = await fetchImpl(pinataSignUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${pinataJwt}`, "content-type": "application/json" },
    body: JSON.stringify({
      network: "public",
      date: Math.floor(Date.now() / 1000),
      expires: 60,
      max_file_size: size,
      mime_types: ["application/json"],
      filename: name,
    }),
  });
  if (!response.ok) throw new Error(`Pinata signing failed (${response.status})`);
  const result = await response.json();
  const url = result.data || result.url;
  if (!url) throw new Error("Pinata did not return a signed upload URL");
  return url;
}

export function createBrowserAuthHttpServer({ auth, pinata, allowedOrigins, serviceDid }) {
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");
    const origin = String(request.headers.origin || "");
    const corsOrigin = allowedOrigins.has(origin) ? origin : "";
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(corsOrigin ? 204 : 403, {
          ...(corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "origin" } : {}),
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        response.end();
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/browser-auth/config") {
        sendJson(response, 200, { serviceDid }, corsOrigin);
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/browser-auth/start") {
        if (!corsOrigin) throw new Error("Origin is not allowed");
        sendJson(response, 202, await auth.start(await readJson(request)), corsOrigin);
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/browser-auth/confirm") {
        const confirmed = await auth.confirm(requestUrl.searchParams.get("token"));
        response.writeHead(303, { location: confirmed.redirectUrl, "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/pinata-upload-url") {
        if (!corsOrigin) throw new Error("Origin is not allowed");
        const body = await readJson(request);
        await pinata.verify(body);
        sendJson(response, 200, { url: await pinata.sign(body) }, corsOrigin);
        return;
      }
      sendJson(response, 404, { error: "Not found" }, corsOrigin);
    } catch (error) {
      sendJson(response, 400, { error: error.message }, corsOrigin);
    }
  });
}

async function main() {
  const required = name => {
    const value = String(process.env[name] || "").trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const allowedOrigins = new Set(required("ARTFI_ALLOWED_ORIGINS").split(",").map(value => new URL(value.trim()).origin));
  const serviceSigner = Ed25519.decode(decodeBase64(required("ARTFI_UCAN_PRIVATE_KEY")));
  if (required("ARTFI_UCAN_SERVICE_DID") !== serviceSigner.did()) {
    throw new Error("ARTFI_UCAN_SERVICE_DID does not match ARTFI_UCAN_PRIVATE_KEY");
  }
  const mailer = nodemailer.createTransport({
    host: required("SMTP_HOST"),
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user: required("SMTP_USER"), pass: required("SMTP_PASS") },
  });
  const nonceStore = new FileNonceStore(process.env.ARTFI_NONCE_STORE || ".data/artfi-auth-nonces.json");
  const auth = createBrowserEmailAuth({
    serviceSigner,
    authSecret: required("ARTFI_AUTH_SECRET"),
    mailer,
    mailFrom: required("SMTP_FROM"),
    publicBaseUrl: required("ARTFI_AUTH_PUBLIC_URL"),
    allowedOrigins,
    nonceStore,
  });
  const profileReader = createOnchainProfileReader({
    rpcUrl: required("BASE_RPC_URL"),
    contractAddress: required("ARTFI_PROTOCOL_ADDRESS"),
  });
  const server = createBrowserAuthHttpServer({
    auth,
    allowedOrigins,
    serviceDid: serviceSigner.did(),
    pinata: {
      verify: body => verifyPinataUploadRequest(body, {
        serviceDid: serviceSigner.did(), allowedOrigins, profileReader, replayStore: nonceStore,
      }),
      sign: body => requestPinataSignedUrl({
        pinataJwt: required("PINATA_JWT"),
        pinataSignUrl: process.env.PINATA_SIGN_URL || "https://uploads.pinata.cloud/v3/files/sign",
        name: body.name,
        size: body.size,
      }),
    },
  });
  const port = Number(process.env.ARTFI_AUTH_PORT || 8787);
  server.listen(port, process.env.ARTFI_AUTH_HOST || "127.0.0.1", () => {
    console.log(`ArtFi browser auth listening on port ${port}`);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}