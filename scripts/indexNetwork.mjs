import "dotenv/config";
import { Contract, Interface, JsonRpcProvider } from "ethers";
import { writeFile } from "node:fs/promises";
import { fetchNetworkLogs } from "./networkLogs.mjs";

const ABI = [
  "event ContentPublished(uint256 indexed publicationId,address indexed publisher,uint8 indexed kind,string cid,bytes32 contentHash,bytes32 agentDidHash,bytes32 statusHash,uint256 publishedAt,string artizenProjectUrl,string artizenFundUrl)",
  "event ContentStatusUpdated(uint256 indexed publicationId,bytes32 indexed statusHash,uint256 timestamp)",
  "event ContentDeactivated(uint256 indexed publicationId,address indexed publisher)",
  "event NodeRegistered(uint256 indexed nodeId,address indexed operator,bytes32 nodeDidHash,bytes32 peerIdHash,string softwareVersion)",
  "event NodeHeartbeat(uint256 indexed nodeId,uint256 indexed month,bytes32 challengeHash,bytes32 sampleProofHash,uint256 sampleCount,uint256 timestamp)",
  "event NodeCheckRecorded(uint256 indexed nodeId,uint256 indexed month,address indexed checker,bytes32 challengeHash,bytes32 sampleProofHash,uint256 sampleCount,uint256 timestamp)",
  "event MonthlyNodeRewardRecorded(uint256 indexed nodeId,uint256 indexed month,address indexed operator,uint256 amount,bytes32 paymentReference)",
];
const PROTOCOL_ABI = [
  "event AdvanceRequested(uint256 indexed requestTokenId,address indexed creator,address indexed asset,uint256 principal,uint256 repaymentAmount,uint256 fundingDeadline,uint256 repaymentDueAt,bytes32 termsHash,string metadataUri,string artizenProjectUrl,string artizenFundUrl)",
];

const rpcUrl = process.env.BASE_RPC_URL;
const registryAddress = process.env.ARTFI_NETWORK_REGISTRY_ADDRESS;
const protocolAddress = process.env.ARTFI_PROTOCOL_ADDRESS;
const output = process.env.ARTFI_NETWORK_INDEX || "artizen-network-index.json";

if (!rpcUrl || !registryAddress) throw new Error("BASE_RPC_URL and ARTFI_NETWORK_REGISTRY_ADDRESS are required");

const provider = new JsonRpcProvider(rpcUrl, 8453, { batchMaxCount: 1 });
const registryInterface = new Interface(ABI);
const protocolInterface = new Interface(PROTOCOL_ABI);
const latestBlock = await provider.getBlockNumber();
const fromBlock = Number(process.env.ARTFI_NETWORK_FROM_BLOCK || 51430773);
const toBlock = Number(process.env.ARTFI_NETWORK_TO_BLOCK || latestBlock);
const fetchLogs = address => fetchNetworkLogs({
  rpcUrl,
  address,
  fromBlock,
  toBlock,
  chunkSize: Number(process.env.ARTFI_NETWORK_CHUNK_SIZE || 20000),
});

const decodeEvents = (logs, iface) => logs.flatMap(log => {
  try {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    return parsed ? [{ name: parsed.name, args: parsed.args, blockNumber: Number(log.blockNumber) }] : [];
  } catch (_) { return []; }
});

const registryEvents = decodeEvents(await fetchLogs(registryAddress), registryInterface);
const requestEvents = protocolAddress
  ? decodeEvents(await fetchLogs(protocolAddress), protocolInterface)
  : [];
const events = name => registryEvents.filter(event => event.name === name);
const published = events("ContentPublished");
const statusUpdates = events("ContentStatusUpdated");
const deactivated = events("ContentDeactivated");
const nodes = events("NodeRegistered");
const heartbeats = events("NodeHeartbeat");
const checkerChecks = events("NodeCheckRecorded");
const rewards = events("MonthlyNodeRewardRecorded");
const requestTokenByUri = new Map(requestEvents.map(event => [event.args.metadataUri, event.args.requestTokenId.toString()]));

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
    ...(Number(args.kind) === 1 && requestTokenByUri.has(args.cid)
      ? { requestTokenId: requestTokenByUri.get(args.cid) }
      : {}),
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
