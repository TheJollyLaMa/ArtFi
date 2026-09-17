import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";

const REGISTRY_ABI = [
  "function monthChallenges(uint256) view returns (bytes32)",
  "function heartbeat(uint256 nodeId,uint256 month,bytes32 challengeHash,bytes32 sampleProofHash,uint256 sampleCount,string softwareVersion)",
  "function recordNodeCheck(uint256 nodeId,uint256 month,bytes32 challengeHash,bytes32 sampleProofHash,uint256 sampleCount)",
];

export function normalizeCid(value) {
  const cid = String(value || "").trim();
  return cid.startsWith("ipfs://") ? cid.slice(7) : cid;
}

export function normalizePrivateKey(value) {
  const key = String(value || "").trim();
  if (/^[a-fA-F0-9]{64}$/.test(key)) return `0x${key}`;
  if (/^0x[a-fA-F0-9]{64}$/.test(key)) return key;
  throw new Error("NODE_PRIVATE_KEY must be 64 hex characters, optionally prefixed with 0x");
}

export async function loadSampleCidsFromIndex({ indexPath = "artizen-network-index.json", limit = 25 } = {}) {
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const publications = Array.isArray(index.publications) ? index.publications : [];
  const cids = publications
    .filter(publication => publication.active !== false)
    .map(publication => normalizeCid(publication.cid))
    .filter(Boolean);
  return [...new Set(cids)].slice(0, limit);
}

export async function pinCids({ cids, apiUrl = "http://127.0.0.1:5001", fetchImpl = fetch }) {
  const pinned = [];
  for (const cid of cids.map(normalizeCid).filter(Boolean)) {
    const endpoint = `${apiUrl.replace(/\/$/, "")}/api/v0/pin/add?arg=${encodeURIComponent(cid)}&recursive=true`;
    const response = await fetchImpl(endpoint, { method: "POST" });
    if (!response.ok) throw new Error(`Could not pin ${cid} (${response.status})`);
    pinned.push(cid);
  }
  return pinned;
}

export async function sampleCids({ cids, apiUrl = "http://127.0.0.1:5001", fetchImpl = fetch }) {
  const results = [];
  for (const cid of cids.map(normalizeCid).filter(Boolean)) {
    const response = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/api/v0/cat?arg=${encodeURIComponent(cid)}`, { method: "POST" });
    if (!response.ok) throw new Error(`Could not retrieve ${cid} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error(`CID ${cid} returned no data`);
    results.push({ cid, size: bytes.length });
  }
  return results;
}

export function createSampleProofHash(results) {
  if (!Array.isArray(results) || results.length === 0) throw new Error("At least one CID sample is required");
  return keccak256(toUtf8Bytes(JSON.stringify(results)));
}

export async function submitHeartbeat({
  rpcUrl,
  privateKey,
  registryAddress,
  nodeId,
  month,
  cids,
  indexPath,
  apiUrl,
  softwareVersion,
  fetchImpl,
  pinBeforeSample = true,
  checkMode = "operator",
}) {
  const sampleCidsForHeartbeat = cids?.length ? cids.map(normalizeCid) : await loadSampleCidsFromIndex({ indexPath });
  if (!sampleCidsForHeartbeat.length) throw new Error("No sample CIDs are available; publish or index ArtFi content first");
  if (pinBeforeSample) await pinCids({ cids: sampleCidsForHeartbeat, apiUrl, fetchImpl });
  const samples = await sampleCids({ cids: sampleCidsForHeartbeat, apiUrl, fetchImpl });
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(normalizePrivateKey(privateKey), provider);
  const registry = new Contract(registryAddress, REGISTRY_ABI, signer);
  const challengeHash = await registry.monthChallenges(month);
  if (challengeHash === `0x${"0".repeat(64)}`) throw new Error("No active challenge is configured for this month");
  const sampleProofHash = createSampleProofHash(samples);
  const transaction = checkMode === "checker"
    ? await registry.recordNodeCheck(nodeId, month, challengeHash, sampleProofHash, samples.length)
    : await registry.heartbeat(
        nodeId,
        month,
        challengeHash,
        sampleProofHash,
        samples.length,
        softwareVersion
      );
  return { transactionHash: transaction.hash, checkMode, challengeHash, sampleProofHash, samples };
}

async function main() {
  const command = process.argv[2] || "heartbeat";
  const required = name => {
    const value = String(process.env[name] || "").trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };

  const cids = String(process.env.ARTFI_SAMPLE_CIDS || "").trim()
    ? process.env.ARTFI_SAMPLE_CIDS.split(",").map(value => value.trim()).filter(Boolean)
    : await loadSampleCidsFromIndex({
        indexPath: process.env.ARTFI_NETWORK_INDEX || "artizen-network-index.json",
        limit: Number(process.env.ARTFI_SAMPLE_LIMIT || 25),
      });
  if (command === "sample-cids") {
    console.log(JSON.stringify({ cids }, null, 2));
    return;
  }
  if (command === "pin-samples") {
    const pinned = await pinCids({ cids, apiUrl: process.env.IPFS_API_URL || "http://127.0.0.1:5001" });
    console.log(JSON.stringify({ pinned }, null, 2));
    return;
  }

  const result = await submitHeartbeat({
    rpcUrl: required("BASE_RPC_URL"),
    privateKey: required("NODE_PRIVATE_KEY"),
    registryAddress: required("ARTFI_NETWORK_REGISTRY_ADDRESS"),
    nodeId: required("ARTFI_NODE_ID"),
    month: process.env.ARTFI_NETWORK_MONTH || new Date().toISOString().slice(0, 7).replace("-", ""),
    cids,
    indexPath: process.env.ARTFI_NETWORK_INDEX || "artizen-network-index.json",
    apiUrl: process.env.IPFS_API_URL || "http://127.0.0.1:5001",
    softwareVersion: process.env.IPFS_SOFTWARE_VERSION || "kubo/ipfs-desktop",
    pinBeforeSample: process.env.ARTFI_PIN_BEFORE_SAMPLE !== "false",
    checkMode: process.env.ARTFI_CHECK_MODE || (command === "spot-check" ? "checker" : "operator"),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
