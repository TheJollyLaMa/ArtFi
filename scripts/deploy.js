const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying ArtFiAdvance on ${network.name} with account:`, deployer.address);

  const ART_TOKEN_ADDRESS =
    process.env.ART_TOKEN_ADDRESS ||
    process.env.USDC_ADDRESS ||
    "0x44c4516768e47cd97cfF2561B81a74699F23f8Ec";
  const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS || deployer.address;
  console.log("Using $ART token:", ART_TOKEN_ADDRESS);
  console.log("Using administrator:", ADMIN_ADDRESS);

  const ArtFiAdvance = await ethers.getContractFactory("ArtFiAdvance");
  const advance = await ArtFiAdvance.deploy(ART_TOKEN_ADDRESS, ADMIN_ADDRESS);
  await advance.waitForDeployment();
  console.log("ArtFiAdvance deployed to:", await advance.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
