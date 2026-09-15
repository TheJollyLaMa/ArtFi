const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying ART.Fi contracts on ${network.name} with account:`, deployer.address);

  const ART_TOKEN_ADDRESS =
    process.env.ART_TOKEN_ADDRESS ||
    process.env.USDC_ADDRESS ||
    "0x44c4516768e47cd97cfF2561B81a74699F23f8Ec";
  const ARTIZEN_DISBURSER = process.env.ARTIZEN_DISBURSER || deployer.address;
  console.log("Using $ART token:", ART_TOKEN_ADDRESS);

  const Registry = await ethers.getContractFactory("ANIVRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  console.log("ANIVRegistry deployed to:", await registry.getAddress());

  const Router = await ethers.getContractFactory("EscrowSettlementRouter");
  const router = await Router.deploy(ART_TOKEN_ADDRESS, ARTIZEN_DISBURSER);
  await router.waitForDeployment();
  console.log("EscrowSettlementRouter deployed to:", await router.getAddress());

  const Vault = await ethers.getContractFactory("InitiationVault");
  const vault = await Vault.deploy(
    ART_TOKEN_ADDRESS,
    await registry.getAddress(),
    await router.getAddress()
  );
  await vault.waitForDeployment();
  console.log("InitiationVault deployed to:", await vault.getAddress());

  await router.setVault(await vault.getAddress());
  await registry.grantRole(await registry.ADMIN_ROLE(), await vault.getAddress());

  console.log("Linked Vault and granted registry admin role to vault.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
