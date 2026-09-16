const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ArtFiProtocol", function () {
  const principal = ethers.parseEther("1");
  const repayment = ethers.parseEther("1.04");
  const projectUrl = "https://artizen.fund/index/p/green-tea-hut-1";
  const fundUrl = "https://artizen.fund/index/f/the-green-tea-party";
  const termsHash = ethers.id("ArtFi terms v2");
  const requestMetadataUri = "ipfs://bafyrequestmetadata000000000000000000000000000001";
  const offerMetadataUri = "ipfs://bafyoffermetadata0000000000000000000000000000001";
  const creatorOutcomeUri = "ipfs://bafycreatoroutcome00000000000000000000000000001";
  const sponsorOutcomeUri = "ipfs://bafysponsoroutcome00000000000000000000000000001";

  let protocol;
  let token;
  let admin;
  let creator;
  let sponsor;
  let buyer;
  let outsider;
  let fundingDeadline;
  let repaymentDueAt;

  const emailHash = account => ethers.solidityPackedKeccak256(
    ["string", "address"],
    [`salted-email-${account.address}`, account.address]
  );
  const profileUrl = account => `https://artizen.fund/profile/${account.address}`;
  const profileUri = account => `ipfs://bafyprofile${account.address.slice(2).toLowerCase()}`;
  const agentDidHash = account => ethers.id(`did:key:${account.address}`);

  beforeEach(async function () {
    [admin, creator, sponsor, buyer, outsider] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("USD Coin", "USDC", 6);
    const ArtFiProtocol = await ethers.getContractFactory("ArtFiProtocol");
    protocol = await ArtFiProtocol.deploy(admin.address);
    await protocol.setAssetSupported(await token.getAddress(), true);

    for (const account of [creator, sponsor, buyer, outsider]) {
      await protocol.connect(account).registerProfile(emailHash(account), agentDidHash(account), profileUri(account));
    }
    const latestBlock = await ethers.provider.getBlock("latest");
    fundingDeadline = latestBlock.timestamp + 3600;
    repaymentDueAt = fundingDeadline + 30 * 24 * 3600;
  });

  function requestTerms(asset = ethers.ZeroAddress, overrides = {}) {
    return {
      asset,
      principal,
      repaymentAmount: repayment,
      fundingDeadline,
      repaymentDueAt,
      termsHash,
      metadataUri: requestMetadataUri,
      artizenProjectUrl: projectUrl,
      artizenFundUrl: fundUrl,
      ...overrides,
    };
  }

  async function createRequest(asset = ethers.ZeroAddress, overrides = {}) {
    await protocol.connect(creator).createRequest(requestTerms(asset, overrides));
    return 1n;
  }

  async function createFundedNative() {
    const requestTokenId = await createRequest();
    await protocol.connect(sponsor).fundRequest(requestTokenId, offerMetadataUri, { value: principal });
    return { requestTokenId, advanceId: 1n, offerTokenId: 2n };
  }

  async function createFundedToken() {
    const asset = await token.getAddress();
    const requestTokenId = await createRequest(asset);
    await token.mint(sponsor.address, principal);
    await token.connect(sponsor).approve(await protocol.getAddress(), principal);
    await protocol.connect(sponsor).fundRequest(requestTokenId, offerMetadataUri);
    return { requestTokenId, advanceId: 1n, offerTokenId: 2n, asset };
  }

  it("registers unique salted email hashes without putting plaintext email on-chain", async function () {
    const profile = await protocol.profiles(creator.address);
    expect(profile.emailHash).to.equal(emailHash(creator));
    expect(profile.agentDidHash).to.equal(agentDidHash(creator));
    expect(profile.profileUri).to.equal(profileUri(creator));
    expect(await protocol.walletForEmailHash(emailHash(creator))).to.equal(creator.address);
    await expect(protocol.connect(admin).registerProfile(emailHash(creator), agentDidHash(admin), profileUri(admin)))
      .to.be.revertedWith("Email hash already registered");
    await expect(protocol.connect(admin).registerProfile(emailHash(admin), agentDidHash(admin), "https://example.com"))
      .to.be.revertedWith("IPFS URI is required");
  });

  it("mints a soulbound request NFT with immutable Artizen and participant links", async function () {
    await expect(protocol.connect(creator).createRequest(requestTerms()))
      .to.emit(protocol, "AdvanceRequested");
    expect(await protocol.ownerOf(1)).to.equal(creator.address);
    expect(await protocol.tokenURI(1)).to.equal(requestMetadataUri);
    const request = await protocol.requests(1);
    expect(request.artizenProjectUrl).to.equal(projectUrl);
    expect(request.artizenFundUrl).to.equal(fundUrl);

    await expect(protocol.connect(creator).transferFrom(creator.address, outsider.address, 1))
      .to.be.revertedWith("Request NFT is non-transferable");
  });

  it("funds an approved ERC-20 request and mints exactly one offer NFT", async function () {
    const { asset } = await createFundedToken();
    expect(await protocol.ownerOf(2)).to.equal(sponsor.address);
    expect(await protocol.totalLiabilities(asset)).to.equal(principal);
    expect(await token.balanceOf(await protocol.getAddress())).to.equal(principal);
    expect(await protocol.tokenURI(2)).to.equal(offerMetadataUri);
    await expect(protocol.connect(sponsor).fundRequest(1, offerMetadataUri)).to.be.revertedWith("Request already funded");
    await expect(protocol.connect(sponsor).transferFrom(sponsor.address, buyer.address, 2))
      .to.be.revertedWith("Offer NFT transfers require active advance");
  });

  it("rejects mismatched asset payments and unsupported assets", async function () {
    const unknownToken = await (await ethers.getContractFactory("MockERC20")).deploy("Other", "OTHER", 18);
    await expect(protocol.connect(creator).createRequest(requestTerms(await unknownToken.getAddress())))
      .to.be.revertedWith("Asset is not supported");

    await createRequest(await token.getAddress());
    await token.mint(sponsor.address, principal);
    await token.connect(sponsor).approve(await protocol.getAddress(), principal);
    await expect(protocol.connect(sponsor).fundRequest(1, offerMetadataUri, { value: principal }))
      .to.be.revertedWith("Native value not accepted for token asset");
  });

  it("transfers active receivable rights and repays the current NFT owner", async function () {
    const { advanceId, offerTokenId } = await createFundedToken();
    await protocol.connect(creator).acceptOffer(advanceId);
    expect(await protocol.totalLiabilities(await token.getAddress())).to.equal(0);
    await expect(protocol.connect(sponsor).transferFrom(sponsor.address, admin.address, offerTokenId))
      .to.be.revertedWith("Recipient profile is required");
    await protocol.connect(sponsor).transferFrom(sponsor.address, buyer.address, offerTokenId);
    expect(await protocol.ownerOf(offerTokenId)).to.equal(buyer.address);

    await token.mint(creator.address, repayment - principal);
    await token.connect(creator).approve(await protocol.getAddress(), repayment);
    await expect(protocol.connect(creator).repay(advanceId))
      .to.emit(protocol, "AdvanceRepaid")
      .withArgs(advanceId, buyer.address, repayment);
    expect(await token.balanceOf(buyer.address)).to.equal(repayment);
    expect((await protocol.advances(advanceId)).status).to.equal(3);
    await expect(protocol.connect(buyer).transferFrom(buyer.address, sponsor.address, offerTokenId))
      .to.be.revertedWith("Offer NFT transfers require active advance");
  });

  it("handles native funding, designated settlement recipients, and accidental-value rejection", async function () {
    const { advanceId } = await createFundedNative();
    expect(await protocol.totalLiabilities(ethers.ZeroAddress)).to.equal(principal);
    await protocol.connect(creator).acceptOffer(advanceId);
    await protocol.connect(sponsor).setSettlementRecipient(advanceId, buyer.address);
    const balanceBefore = await ethers.provider.getBalance(buyer.address);
    await protocol.connect(creator).repay(advanceId, { value: repayment });
    expect(await ethers.provider.getBalance(buyer.address)).to.equal(balanceBefore + repayment);
    await expect(sponsor.sendTransaction({ to: await protocol.getAddress(), value: 1n }))
      .to.be.revertedWith("Use an ArtFi payable function");
  });

  it("allows a creator to make a voluntary late repayment before settlement", async function () {
    const { advanceId } = await createFundedNative();
    await protocol.connect(creator).acceptOffer(advanceId);
    await ethers.provider.send("evm_setNextBlockTimestamp", [repaymentDueAt + 1]);
    await protocol.connect(creator).repay(advanceId, { value: repayment });
    expect((await protocol.advances(advanceId)).status).to.equal(3);
  });

  it("resets a designated destination when the receivable NFT transfers", async function () {
    const { advanceId, offerTokenId } = await createFundedNative();
    await protocol.connect(creator).acceptOffer(advanceId);
    await protocol.connect(sponsor).setSettlementRecipient(advanceId, outsider.address);
    await expect(protocol.connect(sponsor).transferFrom(sponsor.address, buyer.address, offerTokenId))
      .to.emit(protocol, "SettlementDestinationUpdated")
      .withArgs(advanceId, ethers.ZeroAddress);
    expect((await protocol.advances(advanceId)).settlementRecipient).to.equal(ethers.ZeroAddress);
  });

  it("records full and defaulted payout settlements for native and token assets", async function () {
    const { advanceId } = await createFundedToken();
    await protocol.connect(creator).acceptOffer(advanceId);
    const grossPayout = ethers.parseEther("1.5");
    await token.mint(admin.address, grossPayout);
    await token.connect(admin).approve(await protocol.getAddress(), grossPayout);
    await protocol.connect(admin).settleFromPayout(advanceId, grossPayout);
    expect((await protocol.advances(advanceId)).status).to.equal(4);
    expect(await token.balanceOf(sponsor.address)).to.equal(repayment);
    expect(await token.balanceOf(creator.address)).to.equal(principal + grossPayout - repayment);

    await protocol.connect(creator).createRequest(requestTerms());
    await protocol.connect(sponsor).fundRequest(3, offerMetadataUri, { value: principal });
    await protocol.connect(creator).acceptOffer(2);
    const shortPayout = ethers.parseEther("0.4");
    await protocol.connect(admin).settleFromPayout(2, shortPayout, { value: shortPayout });
    expect((await protocol.advances(2)).status).to.equal(7);
    expect((await protocol.walletStats(creator.address)).defaults).to.equal(1);
  });

  it("stores both parties' append-only outcomes in the original NFT metadata", async function () {
    const { advanceId } = await createFundedNative();
    await protocol.connect(creator).acceptOffer(advanceId);
    await protocol.connect(creator).repay(advanceId, { value: repayment });
    const creatorOutcome = ethers.id("creator outcome");
    const sponsorOutcome = ethers.id("sponsor outcome");
    await protocol.connect(creator).submitOutcome(advanceId, 5, creatorOutcome, creatorOutcomeUri);
    await expect(protocol.connect(sponsor).submitOutcome(
      advanceId, 5, sponsorOutcome, sponsorOutcomeUri
    )).to.emit(protocol, "OutcomeFinalized").withArgs(advanceId, creator.address, sponsor.address);

    expect(await protocol.tokenURI(1)).to.equal(creatorOutcomeUri);
    expect(await protocol.tokenURI(2)).to.equal(sponsorOutcomeUri);
    expect((await protocol.outcome(advanceId, creator.address)).rating).to.equal(5);
    await expect(protocol.connect(creator).submitOutcome(
      advanceId, 1, creatorOutcome, "ipfs://bafyrewrite000000000000000000000000000000001"
    )).to.be.revertedWith("Outcome already submitted");
    await expect(protocol.connect(outsider).submitOutcome(
      advanceId, 3, ethers.id("outsider"), "ipfs://bafyoutsider00000000000000000000000000000001"
    )).to.be.revertedWith("Not an outcome participant");
  });

  it("protects escrow liabilities while recovering only excess ERC-20 funds", async function () {
    const { asset } = await createFundedToken();
    const excess = 500_000n;
    await token.mint(await protocol.getAddress(), excess);
    await expect(protocol.recoverUnencumberedFunds(asset, admin.address, excess + 1n))
      .to.be.revertedWith("Funds are encumbered");
    await expect(protocol.connect(outsider).recoverUnencumberedFunds(asset, outsider.address, excess))
      .to.be.revertedWithCustomError(protocol, "AccessControlUnauthorizedAccount");
    await protocol.recoverUnencumberedFunds(asset, admin.address, excess);
    expect(await token.balanceOf(await protocol.getAddress())).to.equal(principal);
    await expect(protocol.setAssetSupported(asset, false)).to.be.revertedWith("Asset backs active escrow");
  });

  it("protects native escrow while recovering only forced excess value", async function () {
    await createFundedNative();
    const excess = ethers.parseEther("0.25");
    await ethers.provider.send("hardhat_setBalance", [
      await protocol.getAddress(),
      ethers.toBeHex(principal + excess),
    ]);
    await expect(protocol.recoverUnencumberedFunds(ethers.ZeroAddress, admin.address, excess + 1n))
      .to.be.revertedWith("Funds are encumbered");
    await protocol.recoverUnencumberedFunds(ethers.ZeroAddress, admin.address, excess);
    expect(await ethers.provider.getBalance(await protocol.getAddress())).to.equal(principal);
  });

  it("returns funded escrow on cancellation and permissionless expiry", async function () {
    await createFundedNative();
    await expect(protocol.connect(sponsor).cancelOffer(1))
      .to.emit(protocol, "AdvanceCancelled")
      .withArgs(1, sponsor.address);
    expect(await protocol.totalLiabilities(ethers.ZeroAddress)).to.equal(0);
    expect((await protocol.walletStats(creator.address)).advancesCompleted).to.equal(0);

    await protocol.connect(creator).createRequest(requestTerms());
    await protocol.connect(sponsor).fundRequest(3, offerMetadataUri, { value: principal });
    await ethers.provider.send("evm_setNextBlockTimestamp", [fundingDeadline + 1]);
    await expect(protocol.connect(outsider).expireOffer(2)).to.emit(protocol, "AdvanceExpired");
    expect(await protocol.totalLiabilities(ethers.ZeroAddress)).to.equal(0);
  });

  it("indexes histories and asset totals by wallet and salted email hash", async function () {
    const { asset, advanceId } = await createFundedToken();
    await protocol.connect(creator).acceptOffer(advanceId);
    await token.mint(creator.address, repayment - principal);
    await token.connect(creator).approve(await protocol.getAddress(), repayment);
    await protocol.connect(creator).repay(advanceId);

    expect(await protocol.creatorRequestTokenIds(creator.address)).to.deep.equal([1n]);
    expect(await protocol.emailRequestTokenIds(emailHash(creator))).to.deep.equal([1n]);
    expect(await protocol.lenderAdvanceIds(sponsor.address)).to.deep.equal([1n]);
    expect(await protocol.emailLenderAdvanceIds(emailHash(sponsor))).to.deep.equal([1n]);
    expect((await protocol.walletStats(creator.address)).advancesCompleted).to.equal(1);
    expect((await protocol.emailStats(emailHash(creator))).advancesCompleted).to.equal(1);
    expect((await protocol.walletAssetStats(creator.address, asset)).principalBorrowed).to.equal(principal);
    expect((await protocol.emailAssetStats(emailHash(sponsor), asset)).principalFunded).to.equal(principal);
  });

  it("enforces fee caps, deadlines, URLs, profile requirements, and settlement authority", async function () {
    await expect(protocol.connect(creator).createRequest(requestTerms(ethers.ZeroAddress, {
      repaymentAmount: ethers.parseEther("1.06"),
    }))).to.be.revertedWith("Fee exceeds cap");
    await expect(protocol.connect(creator).createRequest(requestTerms(ethers.ZeroAddress, {
      artizenProjectUrl: "ipfs://project",
    }))).to.be.revertedWith("HTTPS URL is required");

    await createRequest();
    await expect(protocol.connect(admin).fundRequest(1, offerMetadataUri, { value: principal }))
      .to.be.revertedWith("Sponsor profile is required");
    await protocol.connect(sponsor).fundRequest(1, offerMetadataUri, { value: principal });
    await protocol.connect(creator).acceptOffer(1);
    await expect(protocol.connect(outsider).settleFromPayout(1, principal, { value: principal }))
      .to.be.revertedWithCustomError(protocol, "AccessControlUnauthorizedAccount");
  });

  it("prevents funding a request after its asset is delisted", async function () {
    const asset = await token.getAddress();
    await createRequest(asset);
    await protocol.setAssetSupported(asset, false);
    await token.mint(sponsor.address, principal);
    await token.connect(sponsor).approve(await protocol.getAddress(), principal);
    await expect(protocol.connect(sponsor).fundRequest(1, offerMetadataUri))
      .to.be.revertedWith("Asset is not supported");
  });
});