const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ArtFiAdvance", function () {
  const principal = 100n * 10n ** 18n;
  const repayment = 102n * 10n ** 18n;
  const termsHash = ethers.id("ArtFi advance terms v1");

  let token;
  let advance;
  let admin;
  let sponsor;
  let creator;
  let outsider;
  let acceptanceDeadline;
  let repaymentDueAt;

  beforeEach(async function () {
    [admin, sponsor, creator, outsider] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Art Token", "ART", 18);

    const ArtFiAdvance = await ethers.getContractFactory("ArtFiAdvance");
    advance = await ArtFiAdvance.deploy(await token.getAddress(), admin.address);

    const latestBlock = await ethers.provider.getBlock("latest");
    acceptanceDeadline = latestBlock.timestamp + 3600;
    repaymentDueAt = acceptanceDeadline + 30 * 24 * 3600;

    await token.mint(sponsor.address, 1_000n * 10n ** 18n);
    await token.connect(sponsor).approve(await advance.getAddress(), principal);
  });

  async function createAndAccept() {
    await advance.connect(sponsor).createOffer(
      creator.address,
      principal,
      repayment,
      acceptanceDeadline,
      repaymentDueAt,
      termsHash
    );
    await advance.connect(creator).acceptOffer(1);
  }

  it("escrows sponsor funds and disburses them when the creator accepts", async function () {
    await expect(advance.connect(sponsor).createOffer(
      creator.address,
      principal,
      repayment,
      acceptanceDeadline,
      repaymentDueAt,
      termsHash
    )).to.emit(advance, "AdvanceOffered");

    expect(await token.balanceOf(await advance.getAddress())).to.equal(principal);
    await expect(advance.connect(creator).acceptOffer(1))
      .to.emit(advance, "AdvanceAccepted")
      .withArgs(1, creator.address);
    expect(await token.balanceOf(creator.address)).to.equal(principal);
  });

  it("allows the creator to repay the sponsor", async function () {
    await createAndAccept();
    await token.mint(creator.address, repayment - principal);
    await token.connect(creator).approve(await advance.getAddress(), repayment);

    await expect(advance.connect(creator).repay(1))
      .to.emit(advance, "AdvanceRepaid")
      .withArgs(1, repayment);
    expect(await token.balanceOf(sponsor.address)).to.equal(1_002n * 10n ** 18n);
    expect((await advance.advances(1)).status).to.equal(3);
    await expect(advance.connect(creator).repay(1)).to.be.revertedWith("Advance is not active");
  });

  it("settles from a future payout and sends the remainder to the creator", async function () {
    await createAndAccept();
    const grossPayout = 150n * 10n ** 18n;
    await token.mint(admin.address, grossPayout);
    await token.connect(admin).approve(await advance.getAddress(), grossPayout);

    await expect(advance.connect(admin).settleFromPayout(1, grossPayout))
      .to.emit(advance, "AdvanceSettled")
      .withArgs(1, repayment, grossPayout - repayment, false);
    expect(await token.balanceOf(creator.address)).to.equal(principal + grossPayout - repayment);
    expect((await advance.advances(1)).status).to.equal(4);
    await expect(advance.connect(admin).settleFromPayout(1, grossPayout))
      .to.be.revertedWith("Advance is not active");
  });

  it("records a default when the season payout cannot cover repayment", async function () {
    await createAndAccept();
    const shortPayout = 40n * 10n ** 18n;
    await token.mint(admin.address, shortPayout);
    await token.connect(admin).approve(await advance.getAddress(), shortPayout);

    await expect(advance.connect(admin).settleFromPayout(1, shortPayout))
      .to.emit(advance, "AdvanceSettled")
      .withArgs(1, shortPayout, 0, true);
    expect((await advance.advances(1)).status).to.equal(7);
  });

  it("lets the sponsor cancel an unaccepted offer", async function () {
    await advance.connect(sponsor).createOffer(
      creator.address,
      principal,
      repayment,
      acceptanceDeadline,
      repaymentDueAt,
      termsHash
    );
    await expect(advance.connect(sponsor).cancelOffer(1)).to.emit(advance, "AdvanceCancelled");
    expect(await token.balanceOf(sponsor.address)).to.equal(1_000n * 10n ** 18n);
    expect((await advance.advances(1)).status).to.equal(5);
  });

  it("returns escrow to the sponsor after an offer expires", async function () {
    await advance.connect(sponsor).createOffer(
      creator.address,
      principal,
      repayment,
      acceptanceDeadline,
      repaymentDueAt,
      termsHash
    );
    await ethers.provider.send("evm_setNextBlockTimestamp", [acceptanceDeadline + 1]);
    await expect(advance.connect(outsider).expireOffer(1)).to.emit(advance, "AdvanceExpired");
    expect(await token.balanceOf(sponsor.address)).to.equal(1_000n * 10n ** 18n);
  });

  it("enforces creator, settlement, and fee constraints", async function () {
    await expect(advance.connect(sponsor).createOffer(
      creator.address,
      principal,
      106n * 10n ** 18n,
      acceptanceDeadline,
      repaymentDueAt,
      termsHash
    )).to.be.revertedWith("Fee exceeds cap");

    await advance.connect(sponsor).createOffer(
      creator.address,
      principal,
      repayment,
      acceptanceDeadline,
      repaymentDueAt,
      termsHash
    );
    await expect(advance.connect(outsider).acceptOffer(1)).to.be.revertedWith("Only creator can accept");
    await advance.connect(creator).acceptOffer(1);
    await expect(advance.connect(outsider).settleFromPayout(1, principal))
      .to.be.revertedWithCustomError(advance, "AccessControlUnauthorizedAccount");
  });
});