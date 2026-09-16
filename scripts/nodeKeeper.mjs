import { Contract, JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from "ethers";

const REGISTRY_ABI = [
  "function monthChallenges(uint256) view returns (bytes32)",
  "function heartbeat(uint256 nodeId,uint256 month,bytes32 challengeHash,bytes32 sampleProofHash,uint256 sampleCount,string softwareVersion)",
];

export async function sampleCids({ cids, apiUrl = "http://127.0.0.1:5001", fetchImpl = fetch }) {
  const results = [];
  for (const cid of cids) {
    const response = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/api/v0/cat?arg=${encodeURIComponent(cid)}`);
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
  apiUrl,
  softwareVersion,
  fetchImpl,
}) {
  const samples = await sampleCids({ cids, apiUrl, fetchImpl });
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);
  const registry = new Contract(registryAddress, REGISTRY_ABI, signer);
  const challengeHash = await registry.monthChallenges(month);
  if (challengeHash === `0x${"0".repeat(64)}`) throw new Error("No active challenge is configured for this month");
  const sampleProofHash = createSampleProofHash(samples);
  const transaction = await registry.heartbeat(
    nodeId,
    month,
    challengeHash,
    sampleProofHash,
    samples.length,
    softwareVersion
  );
  return { transactionHash: transaction.hash, challengeHash, sampleProofHash, samples };
}

async function main() {
  const required = name => {
    const value = String(process.env[name] || "").trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const result = await submitHeartbeat({
    rpcUrl: required("BASE_RPC_URL"),
    privateKey: required("NODE_PRIVATE_KEY"),
    registryAddress: required("ARTFI_NETWORK_REGISTRY_ADDRESS"),
    nodeId: required("ARTFI_NODE_ID"),
    month: process.env.ARTFI_NETWORK_MONTH || new Date().toISOString().slice(0, 7).replace("-", ""),
    cids: required("ARTFI_SAMPLE_CIDS").split(",").map(value => value.trim()).filter(Boolean),
    apiUrl: process.env.IPFS_API_URL || "http://127.0.0.1:5001",
    softwareVersion: process.env.IPFS_SOFTWARE_VERSION || "kubo/ipfs-desktop",
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
