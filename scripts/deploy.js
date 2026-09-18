const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying ArtFiProtocol on ${network.name} with account:`, deployer.address);
  const configuredAdmin = process.env.ADMIN_ADDRESS || deployer.address;
  const ADMIN_ADDRESS = network.name === "hardhat" ? deployer.address : configuredAdmin;
  if (network.name === "hardhat" && configuredAdmin.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log("Using the local Hardhat signer as administrator for the ephemeral network.");
  }
  console.log("Using administrator:", ADMIN_ADDRESS);

  const ArtFiProtocol = await ethers.getContractFactory("ArtFiProtocol");
  const protocol = await ArtFiProtocol.deploy(ADMIN_ADDRESS);
  await protocol.waitForDeployment();
  console.log("ArtFiProtocol deployed to:", await protocol.getAddress());

  const ArtFiNetworkRegistry = await ethers.getContractFactory("ArtFiNetworkRegistry");
  const networkRegistry = await ArtFiNetworkRegistry.deploy(await protocol.getAddress(), ADMIN_ADDRESS);
  await networkRegistry.waitForDeployment();
  console.log("ArtFiNetworkRegistry deployed to:", await networkRegistry.getAddress());

  const ArtFiSettlementRouter = await ethers.getContractFactory("ArtFiSettlementRouter");
  const settlementRouter = await ArtFiSettlementRouter.deploy(ADMIN_ADDRESS);
  await settlementRouter.waitForDeployment();
  console.log("ArtFiSettlementRouter deployed to:", await settlementRouter.getAddress());

  const configuredAssets = [
    process.env.ART_TOKEN_ADDRESS,
    ...(process.env.SUPPORTED_ASSETS || "").split(",")
  ].map(value => String(value || "").trim()).filter(Boolean);
  for (const asset of [...new Set(configuredAssets)]) {
    if (!ethers.isAddress(asset) || asset === ethers.ZeroAddress) {
      throw new Error(`Invalid ERC-20 asset address: ${asset}`);
    }
    await (await protocol.setAssetSupported(asset, true)).wait();
    await (await settlementRouter.setAssetApproved(asset, true)).wait();
    console.log("Enabled ERC-20 asset:", asset);
  }

  const initialFundId = process.env.ARTFI_INITIAL_FUND_ID || "artfi-repo-dev";
  const initialFundMetadata = process.env.ARTFI_INITIAL_FUND_METADATA_URI || "ipfs://bafyartfirepodevfundmetadata000000000000000001";
  await (await settlementRouter.createFund(ethers.id(initialFundId), initialFundMetadata)).wait();
  console.log("Created settlement fund:", initialFundId);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
