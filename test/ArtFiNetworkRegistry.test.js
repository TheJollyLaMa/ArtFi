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

  it("requires 25 spaced checks and records one separate 10 ART monthly reward", async function () {
    await registry.connect(operator).registerNode(nodeDidHash, peerIdHash, "kubo-0.34");
    await registry.setMonthChallenge(202609, ethers.id("challenge-1"));
    await registry.setNodeApproval(1, true);
    for (let check = 0; check < 25; check += 1) {
      if (check > 0) {
        const block = await ethers.provider.getBlock("latest");
        await ethers.provider.send("evm_setNextBlockTimestamp", [block.timestamp + 12 * 60 * 60]);
      }
      await registry.connect(operator).heartbeat(
        1,
        202609,
        ethers.id("challenge-1"),
        ethers.id(`sample-${check}`),
        5,
        "kubo-0.34"
      );
    }
    expect(await registry.rewardEligible(1, 202609)).to.equal(true);
    await expect(registry.markMonthlyRewardPaid(1, 202609, ethers.id("manual-art-payment")))
      .to.emit(registry, "MonthlyNodeRewardRecorded")
      .withArgs(1, 202609, operator.address, ethers.parseEther("10"), ethers.id("manual-art-payment"));
    expect(await registry.rewardEligible(1, 202609)).to.equal(false);
    await expect(registry.markMonthlyRewardPaid(1, 202609, ethers.id("duplicate")))
      .to.be.revertedWith("Node is not reward eligible");
  });
});