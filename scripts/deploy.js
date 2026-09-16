const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying ArtFiProtocol on ${network.name} with account:`, deployer.address);
  const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS || deployer.address;
  console.log("Using administrator:", ADMIN_ADDRESS);

  const ArtFiProtocol = await ethers.getContractFactory("ArtFiProtocol");
  const protocol = await ArtFiProtocol.deploy(ADMIN_ADDRESS);
  await protocol.waitForDeployment();
  console.log("ArtFiProtocol deployed to:", await protocol.getAddress());

  const configuredAssets = [
    process.env.ART_TOKEN_ADDRESS,
    ...(process.env.SUPPORTED_ASSETS || "").split(",")
  ].map(value => String(value || "").trim()).filter(Boolean);
  for (const asset of [...new Set(configuredAssets)]) {
    if (!ethers.isAddress(asset) || asset === ethers.ZeroAddress) {
      throw new Error(`Invalid ERC-20 asset address: ${asset}`);
    }
    await (await protocol.setAssetSupported(asset, true)).wait();
    console.log("Enabled ERC-20 asset:", asset);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
