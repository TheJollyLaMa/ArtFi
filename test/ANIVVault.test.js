const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ART.Fi Initiation Vault Flow", function () {
  let vault;
  let registry;
  let router;
  let mockUsdc;
  let owner;
  let welcomer;
  let creator;
  let artizenDisburser;

  beforeEach(async function () {
    [owner, welcomer, creator, artizenDisburser] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockUsdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    const Registry = await ethers.getContractFactory("ANIVRegistry");
    registry = await Registry.deploy(owner.address);

    const Router = await ethers.getContractFactory("EscrowSettlementRouter");
    router = await Router.deploy(
      await mockUsdc.getAddress(),
      artizenDisburser.address
    );

    const Vault = await ethers.getContractFactory("InitiationVault");
    vault = await Vault.deploy(
      await mockUsdc.getAddress(),
      await registry.getAddress(),
      await router.getAddress()
    );

    await router.setVault(await vault.getAddress());
    await registry.grantRole(await registry.ADMIN_ROLE(), await vault.getAddress());

    await registry.registerWelcomer(welcomer.address, "Welcomer_Alice");
    await mockUsdc.mint(await vault.getAddress(), 10000n * 10n ** 6n);
  });

  it("Should allow first-time creator to apply and receive advance from Welcomer", async function () {
    await vault
      .connect(creator)
      .submitApplication(250n * 10n ** 6n, "Materials", "ipfs://QmTestHash");

    await expect(vault.connect(welcomer).approveAndDisburse(1))
      .to.emit(vault, "AdvanceDisbursed")
      .withArgs(creator.address, welcomer.address, 250n * 10n ** 6n);

    expect(await mockUsdc.balanceOf(creator.address)).to.equal(250n * 10n ** 6n);
  });

  it("Should automatically settle loan at end of season when Artizen disburses payout", async function () {
    await vault
      .connect(creator)
      .submitApplication(250n * 10n ** 6n, "Materials", "ipfs://QmTestHash");
    await vault.connect(welcomer).approveAndDisburse(1);

    await mockUsdc.mint(artizenDisburser.address, 1000n * 10n ** 6n);
    await mockUsdc
      .connect(artizenDisburser)
      .approve(await router.getAddress(), 1000n * 10n ** 6n);

    await router
      .connect(artizenDisburser)
      .executeDisbursement(creator.address, 1000n * 10n ** 6n);

    expect(await mockUsdc.balanceOf(creator.address)).to.equal(1000n * 10n ** 6n);
  });
});
