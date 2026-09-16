import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { delegate } from "@ucanto/core";
import * as Delegation from "@ucanto/core/delegation";
import { Verifier } from "@ucanto/principal";
import { getAddress, verifyMessage } from "ethers";

const CHALLENGE_LIFETIME_SECONDS = 15 * 60;
const DELEGATION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const MAX_BINDING_AGE_MS = 10 * 60 * 1000;

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

function encodeArchive(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function requireEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("A valid email address is required");
  }
  return email;
}

function requireBytes32(value, field) {
  const normalized = String(value || "");
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) throw new Error(`${field} must be bytes32`);
  return normalized.toLowerCase();
}

function requireAllowedUrl(value, allowedOrigins) {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Return URL must use HTTPS");
  }
  if (!allowedOrigins.has(url.origin)) throw new Error("Return origin is not allowed");
  url.hash = "";
  return url.toString();
}

function canonicalBindingMessage(binding) {
  return [
    "ArtFi browser authorization",
    `Wallet: ${binding.wallet}`,
    `Agent: ${binding.agentDid}`,
    `Email commitment: ${binding.emailHash}`,
    `Chain ID: ${binding.chainId}`,
    `Origin: ${binding.origin}`,
    `Issued at: ${binding.issuedAt}`,
  ].join("\n");
}

export function verifyWalletAgentBinding(binding, { allowedOrigins, now = Date.now() }) {
  if (!binding || typeof binding !== "object") throw new Error("Wallet-agent binding is required");
  const wallet = getAddress(binding.wallet).toLowerCase();
  const agentDid = String(binding.agentDid || "");
  if (!agentDid.startsWith("did:key:")) throw new Error("Agent DID must use did:key");
  const emailHash = requireBytes32(binding.emailHash, "Email commitment");
  const origin = new URL(String(binding.origin || "")).origin;
  if (!allowedOrigins.has(origin)) throw new Error("Binding origin is not allowed");
  const issuedAtMs = Date.parse(binding.issuedAt);
  if (!Number.isFinite(issuedAtMs) || issuedAtMs > now + 60_000 || now - issuedAtMs > MAX_BINDING_AGE_MS) {
    throw new Error("Wallet-agent binding is expired");
  }
  const normalized = {
    wallet,
    agentDid,
    emailHash,
    chainId: String(binding.chainId),
    origin,
    issuedAt: new Date(issuedAtMs).toISOString(),
  };
  const message = canonicalBindingMessage(normalized);
  if (binding.message !== message) throw new Error("Wallet-agent binding message is not canonical");
  if (verifyMessage(message, binding.signature).toLowerCase() !== wallet) {
    throw new Error("Wallet-agent signature is invalid");
  }
  return normalized;
}

export class MemoryNonceStore {
  constructor() {
    this.used = new Map();
  }

  consume(nonce, expiresAt, now = Date.now()) {
    for (const [key, expiry] of this.used) if (expiry <= now) this.used.delete(key);
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, expiresAt);
    return true;
  }
}

export class FileNonceStore extends MemoryNonceStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    try {
      this.used = new Map(Object.entries(JSON.parse(readFileSync(filePath, "utf8"))));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  consume(nonce, expiresAt, now = Date.now()) {
    if (!super.consume(nonce, expiresAt, now)) return false;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(Object.fromEntries(this.used))}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
    return true;
  }
}

export function createBrowserEmailAuth({
  serviceSigner,
  authSecret,
  mailer,
  mailFrom,
  publicBaseUrl,
  allowedOrigins,
  nonceStore = new MemoryNonceStore(),
  now = () => Date.now(),
}) {
  if (!serviceSigner) throw new Error("UCAN service signer is required");
  if (String(authSecret || "").length < 32) throw new Error("Auth secret must be at least 32 characters");
  if (!mailer?.sendMail) throw new Error("Mailer is required");
  const originSet = new Set(allowedOrigins);
  if (originSet.size === 0) throw new Error("At least one allowed dapp origin is required");
  const baseUrl = new URL(publicBaseUrl);

  function signChallenge(payload) {
    const encoded = encodeBase64Url(JSON.stringify(payload));
    const signature = createHmac("sha256", authSecret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  function readChallenge(token) {
    const [encoded, suppliedSignature, extra] = String(token || "").split(".");
    if (!encoded || !suppliedSignature || extra) throw new Error("Invalid authorization token");
    const expected = createHmac("sha256", authSecret).update(encoded).digest();
    const supplied = decodeBase64Url(suppliedSignature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new Error("Invalid authorization token");
    }
    const payload = JSON.parse(decodeBase64Url(encoded).toString("utf8"));
    if (payload.exp * 1000 <= now()) throw new Error("Authorization link expired");
    return payload;
  }

  async function start({ email, binding, returnUrl }) {
    const recipient = requireEmail(email);
    const verified = verifyWalletAgentBinding(binding, { allowedOrigins: originSet, now: now() });
    const safeReturnUrl = requireAllowedUrl(returnUrl, originSet);
    if (new URL(safeReturnUrl).origin !== verified.origin) throw new Error("Return URL does not match binding origin");
    const expiresAt = now() + CHALLENGE_LIFETIME_SECONDS * 1000;
    const challenge = signChallenge({
      v: 1,
      wallet: verified.wallet,
      agentDid: verified.agentDid,
      emailHash: verified.emailHash,
      origin: verified.origin,
      returnUrl: safeReturnUrl,
      nonce: randomBytes(24).toString("base64url"),
      exp: Math.floor(expiresAt / 1000),
    });
    const confirmationUrl = new URL("/api/browser-auth/confirm", baseUrl);
    confirmationUrl.searchParams.set("token", challenge);
    await mailer.sendMail({
      from: mailFrom,
      to: recipient,
      subject: "Authorize this browser for ArtFi",
      text: `Confirm this browser for ArtFi:\n\n${confirmationUrl}\n\nThis link expires in 15 minutes.`,
      html: `<p>Confirm this browser for ArtFi.</p><p><a href="${confirmationUrl}">Authorize browser</a></p><p>This link expires in 15 minutes.</p>`,
    });
    return { expiresAt: new Date(expiresAt).toISOString() };
  }

  async function confirm(token) {
    const payload = readChallenge(token);
    if (!nonceStore.consume(payload.nonce, payload.exp * 1000, now())) {
      throw new Error("Authorization link already used");
    }
    const expiration = Math.floor(now() / 1000) + DELEGATION_LIFETIME_SECONDS;
    const authorization = await delegate({
      issuer: serviceSigner,
      audience: Verifier.parse(payload.agentDid),
      capabilities: [{
        with: `artfi:wallet:${payload.wallet}`,
        can: "store/add",
        nb: { provider: "pinata", emailHash: payload.emailHash, origin: payload.origin },
      }],
      expiration,
    });
    const archived = await Delegation.archive(authorization);
    if (archived.error) throw archived.error;
    const redirect = new URL(payload.returnUrl);
    redirect.hash = `artfi-email-auth=${encodeURIComponent(encodeArchive(archived.ok))}`;
    return { redirectUrl: redirect.toString(), expiration, wallet: payload.wallet, agentDid: payload.agentDid };
  }

  return { start, confirm };
}

export { canonicalBindingMessage };