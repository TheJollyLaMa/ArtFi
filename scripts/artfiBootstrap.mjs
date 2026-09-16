import "dotenv/config";
import { readFile } from "node:fs/promises";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getBytes,
  isAddress,
  keccak256,
  parseUnits,
  toUtf8Bytes,
} from "ethers";

const ZERO_HASH = `0x${"0".repeat(64)}`;

const protocolAbi = [
  "function profiles(address account) view returns (bytes32 emailHash, bytes32 agentDidHash, string profileUri)",
  "function registerProfile(bytes32 emailHash, bytes32 agentDidHash, string profileUri)",
  "function supportedAssets(address asset) view returns (bool)",
  "function createRequest((address asset,uint256 principal,uint256 repaymentAmount,uint64 fundingDeadline,uint64 repaymentDueAt,bytes32 termsHash,string metadataUri,string artizenProjectUrl,string artizenFundUrl) terms) returns (uint256)",
  "event AdvanceRequested(uint256 indexed requestTokenId,address indexed creator,address indexed asset,uint256 principal,uint256 repaymentAmount,uint256 fundingDeadline,uint256 repaymentDueAt,bytes32 termsHash,string metadataUri,string artizenProjectUrl,string artizenFundUrl)",
];

const registryAbi = [
  "function publicationCount() view returns (uint256)",
  "function nodeCount() view returns (uint256)",
  "function nodes(uint256 nodeId) view returns (address operator,bytes32 nodeDidHash,bytes32 peerIdHash,string softwareVersion,bool approved,bool active)",
  "function registerNode(bytes32 nodeDidHash,bytes32 peerIdHash,string softwareVersion) returns (uint256)",
  "function setNodeApproval(uint256 nodeId,bool approved)",
  "function setMonthChallenge(uint256 month,bytes32 challengeHash)",
  "function publishContent(uint8 kind,string cid,bytes32 contentHash,bytes32 agentDidHash,string artizenProjectUrl,string artizenFundUrl) returns (uint256)",
  "event ContentPublished(uint256 indexed publicationId,address indexed publisher,uint8 indexed kind,string cid,bytes32 contentHash,bytes32 agentDidHash,bytes32 statusHash,uint256 publishedAt,string artizenProjectUrl,string artizenFundUrl)",
  "event NodeRegistered(uint256 indexed nodeId,address indexed operator,bytes32 nodeDidHash,bytes32 peerIdHash,string softwareVersion)",
];

const kindByName = new Map([
  ["profile", 0],
  ["request", 1],
  ["offer", 2],
  ["outcome", 3],
]);

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) args[key] = "true";
    else {
      args[key] = next;
      index += 1;
    }
  }
  return { command, args };
}

function envOrArg(args, key, envName, fallback = "") {
  return String(args[key] || process.env[envName] || fallback).trim();
}

function required(value, name) {
  if (!String(value || "").trim()) throw new Error(`${name} is required`);
  return String(value).trim();
}

function asBytes32(value, name) {
  const text = required(value, name);
  if (/^0x[a-fA-F0-9]{64}$/.test(text)) return text;
  return keccak256(toUtf8Bytes(text));
}

function requireIpfsUri(value, name) {
  const uri = required(value, name);
  if (!uri.startsWith("ipfs://")) throw new Error(`${name} must start with ipfs://`);
  return uri;
}

function requireHttpsUrl(value, name) {
  const url = required(value, name);
  if (!url.startsWith("https://")) throw new Error(`${name} must start with https://`);
  return url;
}

function contracts() {
  const rpcUrl = required(process.env.BASE_RPC_URL, "BASE_RPC_URL");
  const privateKey = required(process.env.PRIVATE_KEY, "PRIVATE_KEY");
  const protocolAddress = required(process.env.ARTFI_PROTOCOL_ADDRESS, "ARTFI_PROTOCOL_ADDRESS");
  const registryAddress = required(process.env.ARTFI_NETWORK_REGISTRY_ADDRESS, "ARTFI_NETWORK_REGISTRY_ADDRESS");
  if (!isAddress(protocolAddress)) throw new Error("ARTFI_PROTOCOL_ADDRESS is not an address");
  if (!isAddress(registryAddress)) throw new Error("ARTFI_NETWORK_REGISTRY_ADDRESS is not an address");
  const provider = new JsonRpcProvider(rpcUrl);
  const signer = new Wallet(privateKey, provider);
  return {
    provider,
    signer,
    protocol: new Contract(protocolAddress, protocolAbi, signer),
    registry: new Contract(registryAddress, registryAbi, signer),
    protocolAddress,
    registryAddress,
  };
}

async function commandVerify() {
  const { provider, signer, protocol, registry, protocolAddress, registryAddress } = contracts();
  const network = await provider.getNetwork();
  const account = await signer.getAddress();
  const [protocolCode, registryCode, profile, publicationCount, nodeCount] = await Promise.all([
    provider.getCode(protocolAddress),
    provider.getCode(registryAddress),
    protocol.profiles(account),
    registry.publicationCount(),
    registry.nodeCount(),
  ]);
  console.log(JSON.stringify({
    network: network.name,
    chainId: network.chainId.toString(),
    signer: account,
    protocol: { address: protocolAddress, deployed: protocolCode !== "0x" },
    registry: { address: registryAddress, deployed: registryCode !== "0x" },
    profileRegistered: profile.emailHash !== ZERO_HASH,
    profileUri: profile.profileUri || "",
    publicationCount: publicationCount.toString(),
    nodeCount: nodeCount.toString(),
  }, null, 2));
}

async function commandNodeHashes(args) {
  let peerId = envOrArg(args, "peer-id", "IPFS_PEER_ID");
  if (!peerId) {
    const apiUrl = envOrArg(args, "api-url", "IPFS_API_URL", "http://127.0.0.1:5001").replace(/\/$/, "");
    const response = await fetch(`${apiUrl}/api/v0/id`, { method: "POST" });
    if (!response.ok) throw new Error(`Could not read Kubo peer ID (${response.status})`);
    peerId = (await response.json()).ID;
  }
  const nodeDid = envOrArg(args, "node-did", "ARTFI_NODE_DID", `did:artfi-node:${peerId}`);
  console.log(JSON.stringify({
    peerId,
    nodeDid,
    nodeDidHash: asBytes32(nodeDid, "node DID"),
    peerIdHash: asBytes32(peerId, "peer ID"),
    softwareVersion: envOrArg(args, "software-version", "IPFS_SOFTWARE_VERSION", "kubo/ipfs-desktop"),
  }, null, 2));
}

async function currentProfile(protocol, account) {
  const profile = await protocol.profiles(account);
  return {
    emailHash: profile.emailHash,
    agentDidHash: profile.agentDidHash,
    profileUri: profile.profileUri,
    registered: profile.emailHash !== ZERO_HASH,
  };
}

async function commandRegisterProfile(args) {
  const { signer, protocol } = contracts();
  const account = await signer.getAddress();
  const existing = await currentProfile(protocol, account);
  if (existing.registered) {
    console.log(JSON.stringify({ status: "already_registered", account, profile: existing }, null, 2));
    return;
  }
  const emailHash = asBytes32(
    envOrArg(args, "email-hash", "ARTFI_PROFILE_EMAIL_HASH") || envOrArg(args, "email", "ARTFI_PROFILE_EMAIL"),
    "ARTFI_PROFILE_EMAIL_HASH or ARTFI_PROFILE_EMAIL"
  );
  const agentDidHash = asBytes32(
    envOrArg(args, "agent-did-hash", "ARTFI_AGENT_DID_HASH") || envOrArg(args, "agent-did", "ARTFI_AGENT_DID"),
    "ARTFI_AGENT_DID_HASH or ARTFI_AGENT_DID"
  );
  const profileUri = requireIpfsUri(envOrArg(args, "profile-uri", "ARTFI_PROFILE_URI"), "ARTFI_PROFILE_URI");
  const transaction = await protocol.registerProfile(emailHash, agentDidHash, profileUri);
  console.log(`Profile registration sent: ${transaction.hash}`);
  await transaction.wait();
  console.log(JSON.stringify({ status: "registered", account, emailHash, agentDidHash, profileUri }, null, 2));
}

async function contentHashFromArgs(args) {
  const hash = envOrArg(args, "content-hash", "ARTFI_CONTENT_HASH");
  if (hash) return asBytes32(hash, "content hash");
  const file = envOrArg(args, "file", "ARTFI_CONTENT_FILE");
  if (!file) throw new Error("Provide --content-hash/ARTFI_CONTENT_HASH or --file/ARTFI_CONTENT_FILE");
  return keccak256(getBytes(await readFile(file)));
}

async function commandPublishContent(args) {
  const { signer, protocol, registry } = contracts();
  const account = await signer.getAddress();
  const profile = await currentProfile(protocol, account);
  if (!profile.registered) throw new Error("Register your ArtFi profile before publishing content");
  const kindName = envOrArg(args, "kind", "ARTFI_CONTENT_KIND", "request").toLowerCase();
  if (!kindByName.has(kindName)) throw new Error("kind must be one of: profile, request, offer, outcome");
  const cid = requireIpfsUri(envOrArg(args, "cid", "ARTFI_CONTENT_CID"), "ARTFI_CONTENT_CID");
  const artizenProjectUrl = requireHttpsUrl(envOrArg(args, "project-url", "ARTFI_PROJECT_URL"), "ARTFI_PROJECT_URL");
  const artizenFundUrl = requireHttpsUrl(envOrArg(args, "fund-url", "ARTFI_FUND_URL"), "ARTFI_FUND_URL");
  const contentHash = await contentHashFromArgs(args);
  const agentDidHash = envOrArg(args, "agent-did-hash", "ARTFI_AGENT_DID_HASH", profile.agentDidHash);
  const transaction = await registry.publishContent(
    kindByName.get(kindName),
    cid,
    contentHash,
    agentDidHash,
    artizenProjectUrl,
    artizenFundUrl
  );
  console.log(`Content publish sent: ${transaction.hash}`);
  const receipt = await transaction.wait();
  const event = receipt.logs.map(log => {
    try { return registry.interface.parseLog(log); }
    catch { return null; }
  }).find(log => log?.name === "ContentPublished");
  console.log(JSON.stringify({
    status: "published",
    publicationId: event?.args.publicationId?.toString() || "unknown",
    kind: kindName,
    cid,
    contentHash,
  }, null, 2));
}

async function commandCreateRequest(args) {
  const { signer, protocol } = contracts();
  const account = await signer.getAddress();
  const profile = await currentProfile(protocol, account);
  if (!profile.registered) throw new Error("Register your ArtFi profile before creating a request");
  const asset = envOrArg(args, "asset", "ARTFI_REQUEST_ASSET", process.env.ART_TOKEN_ADDRESS || ZeroAddress);
  if (!isAddress(asset)) throw new Error("request asset is not an address");
  const supported = await protocol.supportedAssets(asset);
  if (!supported) throw new Error(`Asset is not supported by ArtFiProtocol: ${asset}`);
  const amount = envOrArg(args, "amount", "ARTFI_REQUEST_AMOUNT", "100");
  const repayment = envOrArg(args, "repayment", "ARTFI_REQUEST_REPAYMENT", amount);
  const decimals = Number(envOrArg(args, "decimals", "ARTFI_REQUEST_DECIMALS", "18"));
  const now = Math.floor(Date.now() / 1000);
  const fundingDays = Number(envOrArg(args, "funding-days", "ARTFI_FUNDING_DAYS", "14"));
  const repaymentDays = Number(envOrArg(args, "repayment-days", "ARTFI_REPAYMENT_DAYS", "90"));
  const metadataUri = requireIpfsUri(envOrArg(args, "metadata-uri", "ARTFI_REQUEST_METADATA_URI"), "ARTFI_REQUEST_METADATA_URI");
  const artizenProjectUrl = requireHttpsUrl(envOrArg(args, "project-url", "ARTFI_PROJECT_URL"), "ARTFI_PROJECT_URL");
  const artizenFundUrl = requireHttpsUrl(envOrArg(args, "fund-url", "ARTFI_FUND_URL"), "ARTFI_FUND_URL");
  const terms = {
    asset,
    principal: parseUnits(amount, decimals),
    repaymentAmount: parseUnits(repayment, decimals),
    fundingDeadline: BigInt(now + fundingDays * 24 * 60 * 60),
    repaymentDueAt: BigInt(now + repaymentDays * 24 * 60 * 60),
    termsHash: asBytes32(JSON.stringify({ asset, amount, repayment, decimals, metadataUri, artizenProjectUrl, artizenFundUrl }), "terms"),
    metadataUri,
    artizenProjectUrl,
    artizenFundUrl,
  };
  const transaction = await protocol.createRequest(terms);
  console.log(`Request creation sent: ${transaction.hash}`);
  const receipt = await transaction.wait();
  const event = receipt.logs.map(log => {
    try { return protocol.interface.parseLog(log); }
    catch { return null; }
  }).find(log => log?.name === "AdvanceRequested");
  console.log(JSON.stringify({
    status: "request_created",
    account,
    requestTokenId: event?.args.requestTokenId?.toString() || "unknown",
    asset,
    amount,
    repayment,
    metadataUri,
  }, null, 2));
}

async function commandRegisterNode(args) {
  const { registry } = contracts();
  const nodeDidHash = asBytes32(envOrArg(args, "node-did-hash", "ARTFI_NODE_DID_HASH") || envOrArg(args, "node-did", "ARTFI_NODE_DID"), "node DID hash");
  const peerIdHash = asBytes32(envOrArg(args, "peer-id-hash", "ARTFI_PEER_ID_HASH") || envOrArg(args, "peer-id", "IPFS_PEER_ID"), "peer ID hash");
  const softwareVersion = envOrArg(args, "software-version", "IPFS_SOFTWARE_VERSION", "kubo/ipfs-desktop");
  const transaction = await registry.registerNode(nodeDidHash, peerIdHash, softwareVersion);
  console.log(`Node registration sent: ${transaction.hash}`);
  const receipt = await transaction.wait();
  const event = receipt.logs.map(log => {
    try { return registry.interface.parseLog(log); }
    catch { return null; }
  }).find(log => log?.name === "NodeRegistered");
  console.log(JSON.stringify({
    status: "node_registered",
    nodeId: event?.args.nodeId?.toString() || "unknown",
    nodeDidHash,
    peerIdHash,
    softwareVersion,
  }, null, 2));
}

async function commandApproveNode(args) {
  const { registry } = contracts();
  const nodeId = required(envOrArg(args, "node-id", "ARTFI_NODE_ID"), "ARTFI_NODE_ID");
  const approved = envOrArg(args, "approved", "ARTFI_NODE_APPROVED", "true") !== "false";
  const transaction = await registry.setNodeApproval(nodeId, approved);
  console.log(`Node approval sent: ${transaction.hash}`);
  await transaction.wait();
  console.log(JSON.stringify({ status: "node_approval_updated", nodeId, approved }, null, 2));
}

async function commandSetChallenge(args) {
  const { registry } = contracts();
  const month = envOrArg(args, "month", "ARTFI_NETWORK_MONTH", new Date().toISOString().slice(0, 7).replace("-", ""));
  const seed = envOrArg(args, "seed", "ARTFI_CHALLENGE_SEED", `artfi:${month}`);
  const challengeHash = asBytes32(envOrArg(args, "challenge-hash", "ARTFI_CHALLENGE_HASH", seed), "challenge hash");
  const transaction = await registry.setMonthChallenge(month, challengeHash);
  console.log(`Month challenge sent: ${transaction.hash}`);
  await transaction.wait();
  console.log(JSON.stringify({ status: "challenge_set", month, challengeHash }, null, 2));
}

function printHelp() {
  console.log(`Usage: node scripts/artfiBootstrap.mjs <command> [--key value]

Commands:
  verify             Check deployed protocol/registry addresses and signer profile state.
  node-hashes        Read local Kubo peer ID and print nodeDidHash/peerIdHash values.
  register-profile   Register the signer profile on ArtFiProtocol.
  publish-content    Publish an ipfs:// CID to ArtFiNetworkRegistry.
  create-request     Mint an ArtFi request NFT from an IPFS metadata URI.
  register-node      Register a Kubo/IPFS node with ArtFiNetworkRegistry.
  approve-node       Admin approval for a registered node.
  set-challenge      Admin sets the monthly heartbeat challenge.
`);
}

const { command, args } = parseArgs(process.argv.slice(2));
try {
  if (command === "help" || command === "--help" || command === "-h") printHelp();
  else if (command === "verify") await commandVerify(args);
  else if (command === "node-hashes") await commandNodeHashes(args);
  else if (command === "register-profile") await commandRegisterProfile(args);
  else if (command === "publish-content") await commandPublishContent(args);
  else if (command === "create-request") await commandCreateRequest(args);
  else if (command === "register-node") await commandRegisterNode(args);
  else if (command === "approve-node") await commandApproveNode(args);
  else if (command === "set-challenge") await commandSetChallenge(args);
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}