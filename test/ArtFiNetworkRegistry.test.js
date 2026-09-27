const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("ArtFiNetworkRegistry", function () {
  const projectUrl = "https://artizen.fund/index/p/project";
  const fundUrl = "https://artizen.fund/index/f/fund";
  const cid = "ipfs://bafyartizenmetadata000000000000000000000001";
  const contentHash = ethers.id("metadata bytes");
  const nodeDidHash = ethers.id("node did");
  const peerIdHash = ethers.id("peer id");

  let protocol;
  let registry;
  let admin;
  let creator;
  let operator;
  let checker;
  let outsider;
  let creatorAgentHash;

  beforeEach(async function () {
    [admin, creator, operator, checker, outsider] = await ethers.getSigners();
    const Protocol = await ethers.getContractFactory("ArtFiProtocol");
    protocol = await Protocol.deploy(admin.address);
    creatorAgentHash = ethers.id("creator browser agent");
    await protocol.connect(creator).registerProfile(
      ethers.id("creator email commitment"),
      creatorAgentHash,
      "ipfs://bafycreatorprofile000000000000000000000001"
    );
    const Registry = await ethers.getContractFactory("ArtFiNetworkRegistry");
    registry = await Registry.deploy(await protocol.getAddress(), admin.address);
  });

  it("publishes provider-neutral CID records that an indexer can rebuild from events", async function () {
    await expect(registry.connect(creator).publishContent(
      0,
      cid,
      contentHash,
      creatorAgentHash,
      projectUrl,
      fundUrl
    )).to.emit(registry, "ContentPublished");
    const publication = await registry.publications(1);
    expect(publication.publisher).to.equal(creator.address);
    expect(publication.cid).to.equal(cid);
    expect(publication.statusHash).to.equal(ethers.id("published"));
    expect(publication.active).to.equal(true);
    expect(await registry.publisherPublicationIds(creator.address)).to.deep.equal([1n]);
  });

  it("rejects unregistered wallets, mismatched browser agents, and invalid links", async function () {
    await expect(registry.connect(outsider).publishContent(
      0, cid, contentHash, creatorAgentHash, projectUrl, fundUrl
    )).to.be.revertedWith("Profile is not registered");
    await expect(registry.connect(creator).publishContent(
      0, cid, contentHash, ethers.id("wrong agent"), projectUrl, fundUrl
    )).to.be.revertedWith("Agent DID hash does not match profile");
    await expect(registry.connect(creator).publishContent(
      0, cid, contentHash, creatorAgentHash, "ipfs://not-https", fundUrl
    )).to.be.revertedWith("HTTPS URL is required");
  });

  it("allows a publisher to deactivate a CID without deleting its historical event", async function () {
    await registry.connect(creator).publishContent(1, cid, contentHash, creatorAgentHash, projectUrl, fundUrl);
    await expect(registry.connect(creator).updateContentStatus(1, ethers.id("repaid")))
      .to.emit(registry, "ContentStatusUpdated");
    await expect(registry.connect(creator).deactivateContent(1))
      .to.emit(registry, "ContentDeactivated").withArgs(1, creator.address);
    expect((await registry.publications(1)).active).to.equal(false);
    await expect(registry.connect(creator).deactivateContent(1)).to.be.revertedWith("Content is inactive");
  });

  it("requires approval and rotating challenges for node heartbeats", async function () {
    await registry.connect(operator).registerNode(nodeDidHash, peerIdHash, "kubo-0.34");
    await expect(registry.connect(operator).heartbeat(
      1, 202609, ethers.id("challenge-1"), ethers.id("sample"), 3, "kubo-0.34"
    )).to.be.revertedWith("Node is not approved and active");
    await registry.setMonthChallenge(202609, ethers.id("challenge-1"));
    await registry.setNodeApproval(1, true);
    await expect(registry.connect(operator).heartbeat(
      1, 202609, ethers.id("wrong"), ethers.id("sample"), 3, "kubo-0.34"
    )).to.be.revertedWith("Challenge does not match");
    await expect(registry.connect(operator).heartbeat(
      1, 202609, ethers.id("challenge-1"), ethers.id("sample"), 3, "kubo-0.34"
    )).to.emit(registry, "NodeHeartbeat");
    const stats = await registry.monthStats(1, 202609);
    expect(stats.checks).to.equal(1);
    expect(stats.checkerChecks).to.equal(0);
    expect(await registry.rewardEligible(1, 202609)).to.equal(false);
    await expect(registry.connect(operator).heartbeat(
      1, 202609, ethers.id("challenge-1"), ethers.id("sample"), 3, "kubo-0.34"
    )).to.be.revertedWith("Heartbeat too soon");
  });

  it("allows approved checkers to record independent node checks", async function () {
    await registry.connect(operator).registerNode(nodeDidHash, peerIdHash, "kubo-0.34");
    await registry.setMonthChallenge(202609, ethers.id("challenge-1"));
    await registry.setNodeApproval(1, true);
    const checkerRole = await registry.NODE_CHECKER_ROLE();
    await expect(registry.connect(outsider).recordNodeCheck(
      1, 202609, ethers.id("challenge-1"), ethers.id("sample"), 3
    )).to.be.reverted;
    await registry.grantRole(checkerRole, checker.address);
    await registry.grantRole(checkerRole, operator.address);
    await expect(registry.connect(operator).recordNodeCheck(
      1, 202609, ethers.id("challenge-1"), ethers.id("self-check"), 3
    )).to.be.revertedWith("Node operator cannot check own node");
    await expect(registry.connect(checker).recordNodeCheck(
      1, 202609, ethers.id("challenge-1"), ethers.id("sample"), 3
    )).to.emit(registry, "NodeCheckRecorded")
      .withArgs(1, 202609, checker.address, ethers.id("challenge-1"), ethers.id("sample"), 3, anyValue);
    const stats = await registry.monthStats(1, 202609);
    expect(stats.checks).to.equal(1);
    await expect(registry.connect(checker).recordNodeCheck(
      1, 202609, ethers.id("challenge-1"), ethers.id("sample-2"), 3
    )).to.be.revertedWith("Heartbeat too soon");
  });

  async function prepareEligibleNode(month = 202609, fundReward = true) {
    await registry.connect(operator).registerNode(nodeDidHash, peerIdHash, "kubo-0.34");
    await registry.setMonthChallenge(month, ethers.id("challenge-1"));
    await registry.setNodeApproval(1, true);
    await registry.grantRole(await registry.NODE_CHECKER_ROLE(), checker.address);
    for (let check = 0; check < 25; check += 1) {
      if (check > 0) {
        const block = await ethers.provider.getBlock("latest");
        await ethers.provider.send("evm_setNextBlockTimestamp", [block.timestamp + 12 * 60 * 60]);
      }
      await registry.connect(checker).recordNodeCheck(
        1,
        month,
        ethers.id("challenge-1"),
        ethers.id(`sample-${check}`),
        5
      );
    }
    expect(await registry.rewardEligible(1, month)).to.equal(true);
    const Router = await ethers.getContractFactory("ArtFiSettlementRouter");
    const router = await Router.deploy(admin.address);
    const Token = await ethers.getContractFactory("MockSettlementToken");
    const token = await Token.deploy();
    const fundId = ethers.id("node-reward-fund");
    const routerAddress = await router.getAddress();
    const tokenAddress = await token.getAddress();
    const registryAddress = await registry.getAddress();
    const rewardAmount = ethers.parseEther("10");

    await router.setAssetApproved(tokenAddress, true);
    await router.createFund(fundId, "ipfs://bafynoderewardfundmetadata0000000000000001");
    if (fundReward) {
      await token.approve(routerAddress, rewardAmount);
      await router.fundToken(fundId, tokenAddress, rewardAmount);
    }
    await router.setContributorApproved(operator.address, nodeDidHash, true);
    await router.grantRole(await router.PAYROLL_ROLE(), registryAddress);
    await registry.setNodeRewardPayout(routerAddress, fundId, tokenAddress, rewardAmount);
    return { router, token, fundId, tokenAddress, routerAddress, registryAddress, rewardAmount, month };
  }

  function nodeRewardReference({ registryAddress, fundId, tokenAddress, month }) {
    return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "address", "uint256", "uint256", "bytes32", "address"],
      ["ARTFI_NODE_REWARD_V1", registryAddress, 1, month, fundId, tokenAddress]
    ));
  }

  it("routes eligible 10 ART node rewards through the configured settlement fund", async function () {
    const context = await prepareEligibleNode();
    expect(await registry.rewardEligible(1, context.month)).to.equal(true);
    const workReference = nodeRewardReference(context);

    await expect(registry.markMonthlyRewardPaid(1, context.month))
      .to.emit(context.router, "PayrollPaid")
      .withArgs(context.fundId, context.tokenAddress, operator.address, context.rewardAmount,
        workReference, ethers.id("ArtFi/Network"), nodeDidHash, "", anyValue)
      .and.to.emit(registry, "MonthlyNodeRewardRecorded")
      .withArgs(1, context.month, operator.address, context.rewardAmount, workReference);

    expect(await context.token.balanceOf(operator.address)).to.equal(context.rewardAmount);
    expect(await context.router.fundBalances(context.fundId, context.tokenAddress)).to.equal(0);
    expect(await registry.rewardEligible(1, context.month)).to.equal(false);
    await expect(registry.markMonthlyRewardPaid(1, context.month)).to.be.revertedWith("Node is not reward eligible");
  });

  it("leaves a reward eligible when the treasury cannot pay it", async function () {
    const context = await prepareEligibleNode(202609, false);
    await expect(registry.markMonthlyRewardPaid(1, context.month)).to.be.revertedWith("Insufficient fund balance");
    expect(await registry.rewardEligible(1, context.month)).to.equal(true);
    expect((await registry.monthStats(1, context.month)).rewardPaid).to.equal(false);
  });

  it("requires the Registry to have PAYROLL_ROLE and the node to be router-whitelisted", async function () {
    const Router = await ethers.getContractFactory("ArtFiSettlementRouter");
    const router = await Router.deploy(admin.address);
    const Token = await ethers.getContractFactory("MockSettlementToken");
    const token = await Token.deploy();
    const fundId = ethers.id("node-reward-fund");
    await router.setAssetApproved(await token.getAddress(), true);
    await router.createFund(fundId, "ipfs://bafynoderewardfundmetadata0000000000000001");
    await expect(registry.setNodeRewardPayout(await router.getAddress(), fundId, await token.getAddress(), ethers.parseEther("10")))
      .to.be.revertedWith("Registry needs PAYROLL_ROLE on router");

    await router.grantRole(await router.PAYROLL_ROLE(), await registry.getAddress());
    await registry.setNodeRewardPayout(await router.getAddress(), fundId, await token.getAddress(), ethers.parseEther("10"));
    expect(await registry.nodeRewardRouter()).to.equal(await router.getAddress());
    expect(await registry.nodeRewardFundId()).to.equal(fundId);
  });

  it("allows the admin to recover tokens accidentally sent to the Registry", async function () {
    const Token = await ethers.getContractFactory("MockSettlementToken");
    const token = await Token.deploy();
    const amount = ethers.parseEther("3");
    await token.transfer(await registry.getAddress(), amount);

    await expect(registry.recoverUnencumberedFunds(await token.getAddress(), admin.address, amount))
      .to.emit(registry, "UnencumberedFundsRecovered")
      .withArgs(await token.getAddress(), admin.address, amount);
    expect(await token.balanceOf(await registry.getAddress())).to.equal(0);
    expect(await token.balanceOf(admin.address)).to.equal(ethers.parseEther("1000000"));
  });

  it("allows recovery of forced native funds accidentally sent to the Registry", async function () {
    const ForceSend = await ethers.getContractFactory("ForceSend");
    await ForceSend.deploy(await registry.getAddress(), { value: ethers.parseEther("1") });
    const balanceBefore = await ethers.provider.getBalance(admin.address);

    await expect(registry.recoverUnencumberedFunds(ethers.ZeroAddress, admin.address, ethers.parseEther("1")))
      .to.emit(registry, "UnencumberedFundsRecovered")
      .withArgs(ethers.ZeroAddress, admin.address, ethers.parseEther("1"));
    expect(await ethers.provider.getBalance(await registry.getAddress())).to.equal(0);
    expect(await ethers.provider.getBalance(admin.address)).to.be.greaterThan(balanceBefore);
  });
});