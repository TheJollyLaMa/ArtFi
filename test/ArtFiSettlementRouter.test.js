const { expect } = require("chai");
const { ethers } = require("hardhat");

const NATIVE_ASSET = ethers.ZeroAddress;
const FUND_ID = ethers.id("artfi-repo-dev");
const OTHER_FUND_ID = ethers.id("other-fund");
const WORK_REF = ethers.id("TheJollyLaMa/ArtFi#44");

function payoutArgs(overrides = {}) {
  return {
    fundId: overrides.fundId || FUND_ID,
    asset: overrides.asset || NATIVE_ASSET,
    recipient: overrides.recipient,
    amount: overrides.amount || ethers.parseEther("1"),
    workReference: overrides.workReference || WORK_REF,
    repositoryIdHash: ethers.id("TheJollyLaMa/ArtFi"),
    contributorIdHash: ethers.id("TheJollyLaMa"),
    metadataUri: "ipfs://bafysettlementmetadata000000000000000000000001",
    metadataHash: ethers.id("settlement metadata"),
  };
}

describe("ArtFiSettlementRouter", function () {
  let router;
  let token;
  let admin;
  let payroll;
  let contributor;
  let outsider;

  beforeEach(async function () {
    [admin, payroll, contributor, outsider] = await ethers.getSigners();
    const Router = await ethers.getContractFactory("ArtFiSettlementRouter");
    router = await Router.deploy(admin.address);
    const Token = await ethers.getContractFactory("MockSettlementToken");
    token = await Token.deploy();
    await router.grantRole(await router.PAYROLL_ROLE(), payroll.address);
    await router.setAssetApproved(await token.getAddress(), true);
    await router.createFund(FUND_ID, "ipfs://bafyreifundmetadata000000000000000000000001");
    await router.createFund(OTHER_FUND_ID, "ipfs://bafyotherfundmetadata000000000000000000001");
  });

  it("isolates native balances by fund and pays only from the selected fund", async function () {
    await router.fundNative(FUND_ID, { value: ethers.parseEther("2") });
    await expect(router.connect(payroll).payout(
      ...Object.values(payoutArgs({ recipient: contributor.address }))
    )).to.emit(router, "PayrollPaid");

    expect(await router.fundBalances(FUND_ID, NATIVE_ASSET)).to.equal(ethers.parseEther("1"));
    expect(await router.fundBalances(OTHER_FUND_ID, NATIVE_ASSET)).to.equal(0);
    await expect(router.connect(payroll).payout(
      ...Object.values(payoutArgs({ fundId: OTHER_FUND_ID, recipient: contributor.address, workReference: ethers.id("other") }))
    )).to.be.revertedWith("Insufficient fund balance");
  });

  it("funds and pays approved ERC-20 assets independently", async function () {
    const tokenAddress = await token.getAddress();
    await token.approve(await router.getAddress(), ethers.parseEther("5"));
    await router.fundToken(FUND_ID, tokenAddress, ethers.parseEther("5"));
    await router.connect(payroll).payout(...Object.values(payoutArgs({
      asset: tokenAddress,
      recipient: contributor.address,
      amount: ethers.parseEther("2"),
    })));

    expect(await router.fundBalances(FUND_ID, tokenAddress)).to.equal(ethers.parseEther("3"));
    expect(await token.balanceOf(contributor.address)).to.equal(ethers.parseEther("2"));
  });

  it("settles multiple jobs for one creator in one aggregate payout transaction", async function () {
    const tokenAddress = await token.getAddress();
    const firstReference = ethers.id("job-one");
    const secondReference = ethers.id("job-two");
    await token.approve(await router.getAddress(), ethers.parseEther("5"));
    await router.fundToken(FUND_ID, tokenAddress, ethers.parseEther("5"));

    const tx = await router.connect(payroll).payoutBatch(
      FUND_ID,
      tokenAddress,
      contributor.address,
      [ethers.parseEther("2"), ethers.parseEther("1")],
      [firstReference, secondReference],
      [ethers.id("repo"), ethers.id("repo")],
      [ethers.id("creator"), ethers.id("creator")],
      ["ipfs://job-one", "ipfs://job-two"],
      [ethers.id("job-one"), ethers.id("job-two")]
    );

    await expect(tx).to.emit(router, "PayrollPaid").withArgs(
      FUND_ID,
      tokenAddress,
      contributor.address,
      ethers.parseEther("2"),
      firstReference,
      ethers.id("repo"),
      ethers.id("creator"),
      "ipfs://job-one",
      ethers.id("job-one")
    );
    expect(await router.fundBalances(FUND_ID, tokenAddress)).to.equal(ethers.parseEther("2"));
    expect(await token.balanceOf(contributor.address)).to.equal(ethers.parseEther("3"));
    expect(await router.completedWorkReferences(FUND_ID, secondReference)).to.equal(true);
  });

  it("pays from approved token balances that are not assigned to a fund", async function () {
    const tokenAddress = await token.getAddress();
    await token.approve(await router.getAddress(), ethers.parseEther("5"));
    await router.fundToken(FUND_ID, tokenAddress, ethers.parseEther("2"));
    await router.connect(payroll).payout(...Object.values(payoutArgs({
      asset: tokenAddress,
      recipient: contributor.address,
      amount: ethers.parseEther("1"),
    })));
    await token.transfer(await router.getAddress(), ethers.parseEther("2"));

    const tx = await router.connect(payroll).payoutUnallocated(
      tokenAddress,
      contributor.address,
      ethers.parseEther("1"),
      ethers.id("unused-token-bounty"),
      ethers.id("TheJollyLaMa/ArtFi"),
      ethers.id("TheJollyLaMa"),
      "ipfs://bafyfreebalancepay000000000000000000000001",
      ethers.id("free-balance-payout")
    );

    await expect(tx).to.emit(router, "PayrollPaid");
    expect(await token.balanceOf(contributor.address)).to.equal(ethers.parseEther("2"));
  });

  it("rejects unauthorized payouts and duplicate work references", async function () {
    await router.fundNative(FUND_ID, { value: ethers.parseEther("2") });
    await expect(router.connect(outsider).payout(
      ...Object.values(payoutArgs({ recipient: contributor.address }))
    )).to.be.reverted;
    await router.connect(payroll).payout(...Object.values(payoutArgs({ recipient: contributor.address })));
    await expect(router.connect(payroll).payout(
      ...Object.values(payoutArgs({ recipient: contributor.address }))
    )).to.be.revertedWith("Work already paid");
  });

  it("cannot recover allocated balances but can recover excess", async function () {
    await router.fundNative(FUND_ID, { value: ethers.parseEther("2") });
    await expect(router.recoverExcess(NATIVE_ASSET, admin.address, ethers.parseEther("1")))
      .to.be.revertedWith("Amount is allocated");
    const ForceSend = await ethers.getContractFactory("ForceSend");
    await ForceSend.deploy(await router.getAddress(), { value: ethers.parseEther("1") });
    await expect(router.recoverExcess(NATIVE_ASSET, admin.address, ethers.parseEther("1")))
      .to.emit(router, "ExcessRecovered");
  });

  it("allows the admin to recover an individual fund allocation", async function () {
    const tokenAddress = await token.getAddress();
    await token.approve(await router.getAddress(), ethers.parseEther("5"));
    await router.fundToken(FUND_ID, tokenAddress, ethers.parseEther("5"));

    await expect(router.recoverFund(
      FUND_ID,
      tokenAddress,
      admin.address,
      ethers.parseEther("2")
    )).to.emit(router, "ExcessRecovered");

    expect(await router.fundBalances(FUND_ID, tokenAddress)).to.equal(ethers.parseEther("3"));
    expect(await router.totalFundBalances(tokenAddress)).to.equal(ethers.parseEther("3"));
    expect(await token.balanceOf(admin.address)).to.equal(ethers.parseEther("999997"));
  });

  it("does not allow fund recovery to exceed the selected allocation", async function () {
    await router.fundNative(FUND_ID, { value: ethers.parseEther("1") });
    await expect(router.recoverFund(
      FUND_ID,
      NATIVE_ASSET,
      admin.address,
      ethers.parseEther("2")
    )).to.be.revertedWith("Amount exceeds fund balance");
  });

  it("pauses deposits and payouts", async function () {
    await router.pause();
    await expect(router.fundNative(FUND_ID, { value: 1n })).to.be.reverted;
    await expect(router.connect(payroll).payout(
      ...Object.values(payoutArgs({ recipient: contributor.address }))
    )).to.be.reverted;
  });
});
