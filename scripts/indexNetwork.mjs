import "dotenv/config";
import { Contract, JsonRpcProvider } from "ethers";
import { writeFile } from "node:fs/promises";

const ABI = [
  "event ContentPublished(uint256 indexed publicationId,address indexed publisher,uint8 indexed kind,string cid,bytes32 contentHash,bytes32 agentDidHash,bytes32 statusHash,uint256 publishedAt,string artizenProjectUrl,string artizenFundUrl)",
  "event ContentStatusUpdated(uint256 indexed publicationId,bytes32 indexed statusHash,uint256 timestamp)",
  "event ContentDeactivated(uint256 indexed publicationId,address indexed publisher)",
  "event NodeRegistered(uint256 indexed nodeId,address indexed operator,bytes32 nodeDidHash,bytes32 peerIdHash,string softwareVersion)",
  "event NodeHeartbeat(uint256 indexed nodeId,uint256 indexed month,bytes32 challengeHash,bytes32 sampleProofHash,uint256 sampleCount,uint256 timestamp)",
  "event NodeCheckRecorded(uint256 indexed nodeId,uint256 indexed month,address indexed checker,bytes32 challengeHash,bytes32 sampleProofHash,uint256 sampleCount,uint256 timestamp)",
  "event MonthlyNodeRewardRecorded(uint256 indexed nodeId,uint256 indexed month,address indexed operator,uint256 amount,bytes32 paymentReference)",
];

const rpcUrl = process.env.BASE_RPC_URL;
const registryAddress = process.env.ARTFI_NETWORK_REGISTRY_ADDRESS;
const output = process.env.ARTFI_NETWORK_INDEX || "artizen-network-index.json";

if (!rpcUrl || !registryAddress) throw new Error("BASE_RPC_URL and ARTFI_NETWORK_REGISTRY_ADDRESS are required");

const registry = new Contract(registryAddress, ABI, new JsonRpcProvider(rpcUrl));
const latestBlock = await registry.runner.provider.getBlockNumber();
const fromBlock = Number(process.env.ARTFI_NETWORK_FROM_BLOCK || Math.max(0, latestBlock - 1999));
const toBlock = Number(process.env.ARTFI_NETWORK_TO_BLOCK || latestBlock);
const [published, statusUpdates, deactivated, nodes, heartbeats, checkerChecks, rewards] = await Promise.all([
  registry.queryFilter(registry.filters.ContentPublished(), fromBlock, toBlock),
  registry.queryFilter(registry.filters.ContentStatusUpdated(), fromBlock, toBlock),
  registry.queryFilter(registry.filters.ContentDeactivated(), fromBlock, toBlock),
  registry.queryFilter(registry.filters.NodeRegistered(), fromBlock, toBlock),
  registry.queryFilter(registry.filters.NodeHeartbeat(), fromBlock, toBlock),
  registry.queryFilter(registry.filters.NodeCheckRecorded(), fromBlock, toBlock),
  registry.queryFilter(registry.filters.MonthlyNodeRewardRecorded(), fromBlock, toBlock),
]);

const records = new Map();
for (const event of published) {
  const args = event.args;
  records.set(args.publicationId.toString(), {
    publicationId: args.publicationId.toString(),
    publisher: args.publisher,
    kind: Number(args.kind),
    cid: args.cid,
    contentHash: args.contentHash,
    agentDidHash: args.agentDidHash,
    statusHash: args.statusHash,
    publishedAt: args.publishedAt.toString(),
    artizenProjectUrl: args.artizenProjectUrl,
    artizenFundUrl: args.artizenFundUrl,
    active: true,
  });
}
for (const event of statusUpdates) {
  const record = records.get(event.args.publicationId.toString());
  if (record) {
    record.statusHash = event.args.statusHash;
    record.statusAt = event.args.timestamp.toString();
  }
}
for (const event of deactivated) {
  const record = records.get(event.args.publicationId.toString());
  if (record) record.active = false;
}

const index = {
  generatedAt: new Date().toISOString(),
  registry: registryAddress,
  fromBlock,
  toBlock,
  publications: [...records.values()],
  nodes: nodes.map(event => ({
    nodeId: event.args.nodeId.toString(),
    operator: event.args.operator,
    nodeDidHash: event.args.nodeDidHash,
    peerIdHash: event.args.peerIdHash,
    softwareVersion: event.args.softwareVersion,
  })),
  heartbeats: [
    ...heartbeats.map(event => ({
      source: "operator",
      nodeId: event.args.nodeId.toString(),
      month: event.args.month.toString(),
      sampleProofHash: event.args.sampleProofHash,
      sampleCount: event.args.sampleCount.toString(),
      timestamp: event.args.timestamp.toString(),
    })),
    ...checkerChecks.map(event => ({
      source: "checker",
      nodeId: event.args.nodeId.toString(),
      month: event.args.month.toString(),
      checker: event.args.checker,
      sampleProofHash: event.args.sampleProofHash,
      sampleCount: event.args.sampleCount.toString(),
      timestamp: event.args.timestamp.toString(),
    })),
  ].sort((first, second) => Number(first.timestamp) - Number(second.timestamp)),
  rewards: rewards.map(event => ({
    nodeId: event.args.nodeId.toString(),
    month: event.args.month.toString(),
    operator: event.args.operator,
    amount: event.args.amount.toString(),
    paymentReference: event.args.paymentReference,
  })),
};

await writeFile(output, `${JSON.stringify(index, null, 2)}\n`);
console.log(`Indexed ${index.publications.length} publications and ${index.nodes.length} nodes from ${fromBlock} to ${toBlock}.`);
