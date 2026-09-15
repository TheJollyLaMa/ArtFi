const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying ART.Fi Contracts with account:", deployer.address);

  const USDC_ADDRESS =
    process.env.USDC_ADDRESS || "0x5fd84259d666db4e9e03e766c615666a7b018b31";
  const ARTIZEN_DISBURSER = process.env.ARTIZEN_DISBURSER || deployer.address;

  const Registry = await ethers.getContractFactory("ANIVRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  console.log("ANIVRegistry deployed to:", await registry.getAddress());

  const Router = await ethers.getContractFactory("EscrowSettlementRouter");
  const router = await Router.deploy(USDC_ADDRESS, ARTIZEN_DISBURSER);
  await router.waitForDeployment();
  console.log("EscrowSettlementRouter deployed to:", await router.getAddress());

  const Vault = await ethers.getContractFactory("InitiationVault");
  const vault = await Vault.deploy(
    USDC_ADDRESS,
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
