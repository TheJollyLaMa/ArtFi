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
    await router.setContributorApproved(contributor.address, ethers.id("contributor-github"), true);
    await router.setContributorApproved(admin.address, ethers.id("TheJollyLaMa"), true);
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
    expect(await router.completedWorkReferences(secondReference)).to.equal(true);
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
    )).to.emit(router, "FundRecovered");

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

  it("blocks reusing a work reference across a fund and the unallocated balance", async function () {
    const tokenAddress = await token.getAddress();
    const sharedReference = ethers.id("TheJollyLaMa/ArtFi#99:TheJollyLaMa:contributor");
    await token.approve(await router.getAddress(), ethers.parseEther("5"));
    await router.fundToken(FUND_ID, tokenAddress, ethers.parseEther("2"));
    await token.transfer(await router.getAddress(), ethers.parseEther("3"));

    await router.connect(payroll).payout(...Object.values(payoutArgs({
      asset: tokenAddress,
      recipient: contributor.address,
      amount: ethers.parseEther("1"),
      workReference: sharedReference,
    })));

    await expect(router.connect(payroll).payoutUnallocated(
      tokenAddress,
      contributor.address,
      ethers.parseEther("1"),
      sharedReference,
      ethers.id("repo"),
      ethers.id("creator"),
      "ipfs://duplicate-attempt",
      ethers.id("duplicate-attempt")
    )).to.be.revertedWith("Work already paid");
  });

  it("credits only the received amount for fee-on-transfer tokens", async function () {
    const FeeToken = await ethers.getContractFactory("FeeOnTransferToken");
    const feeToken = await FeeToken.deploy();
    const feeAddress = await feeToken.getAddress();
    await router.setAssetApproved(feeAddress, true);
    await feeToken.approve(await router.getAddress(), ethers.parseEther("100"));
    await router.fundToken(FUND_ID, feeAddress, ethers.parseEther("100"));

    const credited = await router.fundBalances(FUND_ID, feeAddress);
    const actuallyHeld = await feeToken.balanceOf(await router.getAddress());
    expect(credited).to.equal(ethers.parseEther("99"));
    expect(credited).to.equal(actuallyHeld);
  });

  it("rejects duplicate work references inside a single batch", async function () {
    const tokenAddress = await token.getAddress();
    const repeated = ethers.id("same-job");
    await token.approve(await router.getAddress(), ethers.parseEther("5"));
    await router.fundToken(FUND_ID, tokenAddress, ethers.parseEther("5"));

    await expect(router.connect(payroll).payoutBatch(
      FUND_ID,
      tokenAddress,
      contributor.address,
      [ethers.parseEther("1"), ethers.parseEther("1")],
      [repeated, repeated],
      [ethers.id("repo"), ethers.id("repo")],
      [ethers.id("creator"), ethers.id("creator")],
      ["ipfs://a", "ipfs://b"],
      [ethers.id("a"), ethers.id("b")]
    )).to.be.revertedWith("Duplicate work reference");
  });

  it("keeps deactivated funds manageable and prevents overwriting them", async function () {
    await router.setFundActive(FUND_ID, false);
    await expect(router.createFund(FUND_ID, "ipfs://overwrite-attempt"))
      .to.be.revertedWith("Fund already exists");

    await router.setFundActive(FUND_ID, true);
    expect((await router.funds(FUND_ID)).active).to.equal(true);
    await expect(router.createFund(ethers.id("empty-uri-fund"), ""))
      .to.be.revertedWith("Fund metadata URI is required");
  });

  it("enumerates every created fund on-chain", async function () {
    expect(await router.fundCount()).to.equal(2);
    expect(await router.allFundIds()).to.deep.equal([FUND_ID, OTHER_FUND_ID]);
  });

  it("refuses to pay a wallet that is not on the contract whitelist", async function () {
    await router.fundNative(FUND_ID, { value: ethers.parseEther("2") });
    await expect(router.connect(payroll).payout(
      ...Object.values(payoutArgs({ recipient: outsider.address }))
    )).to.be.revertedWith("Recipient is not whitelisted");
  });

  it("blocks batch and unallocated payouts to wallets that are not whitelisted", async function () {
    const tokenAddress = await token.getAddress();
    await token.approve(await router.getAddress(), ethers.parseEther("5"));
    await router.fundToken(FUND_ID, tokenAddress, ethers.parseEther("2"));
    await token.transfer(await router.getAddress(), ethers.parseEther("3"));

    await expect(router.connect(payroll).payoutBatch(
      FUND_ID,
      tokenAddress,
      outsider.address,
      [ethers.parseEther("1")],
      [ethers.id("batch-outsider")],
      [ethers.id("repo")],
      [ethers.id("creator")],
      ["ipfs://batch-outsider"],
      [ethers.id("batch-outsider")]
    )).to.be.revertedWith("Recipient is not whitelisted");

    await expect(router.connect(payroll).payoutUnallocated(
      tokenAddress,
      outsider.address,
      ethers.parseEther("1"),
      ethers.id("unallocated-outsider"),
      ethers.id("repo"),
      ethers.id("creator"),
      "ipfs://unallocated-outsider",
      ethers.id("unallocated-outsider")
    )).to.be.revertedWith("Recipient is not whitelisted");
  });

  it("stops paying a contributor once their approval is revoked", async function () {
    await router.fundNative(FUND_ID, { value: ethers.parseEther("3") });
    await router.connect(payroll).payout(...Object.values(payoutArgs({ recipient: contributor.address })));

    await expect(router.setContributorApproved(contributor.address, ethers.ZeroHash, false))
      .to.emit(router, "ContributorApprovalUpdated")
      .withArgs(contributor.address, ethers.id("contributor-github"), false);

    await expect(router.connect(payroll).payout(
      ...Object.values(payoutArgs({ recipient: contributor.address, workReference: ethers.id("after-revoke") }))
    )).to.be.revertedWith("Recipient is not whitelisted");
  });

  it("mirrors a whitelist in one call and exposes it for verification", async function () {
    await router.setContributorsApproved(
      [outsider.address, contributor.address],
      [ethers.id("outsider-github"), ethers.id("contributor-github")],
      [true, false]
    );

    expect(await router.isApprovedRecipient(outsider.address)).to.equal(true);
    expect(await router.isApprovedRecipient(contributor.address)).to.equal(false);
    expect(await router.contributorCount()).to.equal(3);
    expect(await router.allContributorWallets()).to.deep.equal([
      contributor.address,
      admin.address,
      outsider.address,
    ]);
    expect((await router.contributors(outsider.address)).githubIdHash).to.equal(ethers.id("outsider-github"));
  });

  it("lets the admin recover funds to a wallet that is not whitelisted", async function () {
    const tokenAddress = await token.getAddress();
    await token.approve(await router.getAddress(), ethers.parseEther("5"));
    await router.fundToken(FUND_ID, tokenAddress, ethers.parseEther("5"));

    await expect(router.recoverFund(FUND_ID, tokenAddress, outsider.address, ethers.parseEther("5")))
      .to.emit(router, "FundRecovered");
    expect(await token.balanceOf(outsider.address)).to.equal(ethers.parseEther("5"));
  });

  it("requires a GitHub identity hash when approving a contributor", async function () {
    await expect(router.setContributorApproved(outsider.address, ethers.ZeroHash, true))
      .to.be.revertedWith("GitHub ID hash is required");
  });

  it("restricts whitelist changes to the contributor admin role", async function () {
    await expect(router.connect(outsider).setContributorApproved(
      outsider.address,
      ethers.id("self-approval"),
      true
    )).to.be.reverted;
  });
});
