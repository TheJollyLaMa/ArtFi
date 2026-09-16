import * as Ed25519 from "@ucanto/principal/ed25519";

const signer = await Ed25519.generate();
console.log(`ARTFI_UCAN_SERVICE_DID=${signer.did()}`);
console.log(`ARTFI_UCAN_PRIVATE_KEY=${Buffer.from(Ed25519.encode(signer)).toString("base64")}`);