// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4906} from "@openzeppelin/contracts/interfaces/IERC4906.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract ArtFiProtocol is ERC721, AccessControl, ReentrancyGuard, IERC4906 {
    using SafeERC20 for IERC20;

    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    enum AdvanceStatus { None, Funded, Active, Repaid, Settled, Cancelled, Expired, Defaulted }
    enum TokenKind { None, Request, Offer }

    struct Profile {
        bytes32 emailHash;
        bytes32 agentDidHash;
        string profileUri;
    }

    struct RequestTerms {
        address asset;
        uint256 principal;
        uint256 repaymentAmount;
        uint64 fundingDeadline;
        uint64 repaymentDueAt;
        bytes32 termsHash;
        string metadataUri;
        string artizenProjectUrl;
        string artizenFundUrl;
    }

    struct AdvanceRequest {
        address creator;
        bytes32 creatorEmailHash;
        address asset;
        uint256 principal;
        uint256 repaymentAmount;
        uint64 createdAt;
        uint64 fundingDeadline;
        uint64 repaymentDueAt;
        bytes32 termsHash;
        string metadataUri;
        string artizenProjectUrl;
        string artizenFundUrl;
        uint256 advanceId;
    }

    struct Advance {
        uint256 requestTokenId;
        uint256 offerTokenId;
        address sponsor;
        address beneficiary;
        address settlementRecipient;
        uint64 fundedAt;
        uint64 acceptedAt;
        uint64 closedAt;
        uint256 recoveredAmount;
        uint256 creatorPayout;
        AdvanceStatus status;
        string metadataUri;
    }

    struct ParticipantStats {
        uint256 requestsCreated;
        uint256 offersFunded;
        uint256 advancesAccepted;
        uint256 advancesCompleted;
        uint256 defaults;
        uint256 outcomesSubmitted;
    }

    struct AssetStats {
        uint256 principalFunded;
        uint256 principalBorrowed;
        uint256 amountRepaid;
        uint256 amountRecovered;
        uint256 creatorPayouts;
    }

    struct OutcomeAttestation {
        uint8 rating;
        bytes32 outcomeHash;
        string metadataUri;
        uint64 submittedAt;
    }

    struct TokenRecord {
        TokenKind kind;
        uint256 requestTokenId;
        uint256 advanceId;
    }

    uint256 public advanceCount;
    uint256 public tokenCount;

    mapping(address => bool) public supportedAssets;
    mapping(address => uint256) public totalLiabilities;
    mapping(address => Profile) public profiles;
    mapping(bytes32 => address) public walletForEmailHash;
    mapping(uint256 => AdvanceRequest) public requests;
    mapping(uint256 => Advance) public advances;
    mapping(uint256 => TokenRecord) public tokenRecords;
    mapping(address => ParticipantStats) public walletStats;
    mapping(bytes32 => ParticipantStats) public emailStats;
    mapping(address => mapping(address => AssetStats)) public walletAssetStats;
    mapping(bytes32 => mapping(address => AssetStats)) public emailAssetStats;
    mapping(address => uint256[]) private _creatorRequestTokenIds;
    mapping(address => uint256[]) private _lenderAdvanceIds;
    mapping(bytes32 => uint256[]) private _emailRequestTokenIds;
    mapping(bytes32 => uint256[]) private _emailLenderAdvanceIds;
    mapping(uint256 => mapping(address => OutcomeAttestation)) private _outcomes;

    event ProfileRegistered(
        address indexed account,
        bytes32 indexed emailHash,
        bytes32 indexed agentDidHash,
        string profileUri
    );
    event AssetSupportUpdated(address indexed asset, bool supported);
    event AdvanceRequested(
        uint256 indexed requestTokenId,
        address indexed creator,
        address indexed asset,
        uint256 principal,
        uint256 repaymentAmount,
        uint256 fundingDeadline,
        uint256 repaymentDueAt,
        bytes32 termsHash,
        string metadataUri,
        string artizenProjectUrl,
        string artizenFundUrl
    );
    event AdvanceFunded(
        uint256 indexed advanceId,
        uint256 indexed requestTokenId,
        uint256 indexed offerTokenId,
        address sponsor,
        string metadataUri
    );
    event AdvanceAccepted(uint256 indexed advanceId, address indexed creator);
    event AdvanceRepaid(uint256 indexed advanceId, address indexed beneficiary, uint256 amount);
    event AdvanceSettled(
        uint256 indexed advanceId,
        address indexed beneficiary,
        uint256 recoveredAmount,
        uint256 creatorPayout,
        bool defaulted
    );
    event AdvanceCancelled(uint256 indexed advanceId, address indexed beneficiary);
    event AdvanceExpired(uint256 indexed advanceId, address indexed beneficiary);
    event SettlementDestinationUpdated(uint256 indexed advanceId, address indexed destination);
    event OutcomeSubmitted(
        uint256 indexed advanceId,
        address indexed participant,
        uint8 rating,
        bytes32 outcomeHash,
        string metadataUri
    );
    event OutcomeFinalized(uint256 indexed advanceId, address indexed creator, address indexed beneficiary);
    event UnencumberedFundsRecovered(address indexed asset, address indexed recipient, uint256 amount);

    constructor(address defaultAdmin) ERC721("ArtFi Advance", "ARTFI") {
        require(defaultAdmin != address(0), "Admin is required");
        supportedAssets[address(0)] = true;
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(SETTLEMENT_ROLE, defaultAdmin);
        emit AssetSupportUpdated(address(0), true);
    }

    receive() external payable {
        revert("Use an ArtFi payable function");
    }

    function registerProfile(bytes32 emailHash, bytes32 agentDidHash, string calldata profileUri) external {
        require(profiles[msg.sender].emailHash == bytes32(0), "Profile already registered");
        require(emailHash != bytes32(0), "Email hash is required");
        require(agentDidHash != bytes32(0), "Agent DID hash is required");
        require(walletForEmailHash[emailHash] == address(0), "Email hash already registered");
        _requireIpfsUri(profileUri);
        profiles[msg.sender] = Profile(emailHash, agentDidHash, profileUri);
        walletForEmailHash[emailHash] = msg.sender;
        emit ProfileRegistered(msg.sender, emailHash, agentDidHash, profileUri);
    }

    function setAssetSupported(address asset, bool supported) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!supported) require(totalLiabilities[asset] == 0, "Asset backs active escrow");
        supportedAssets[asset] = supported;
        emit AssetSupportUpdated(asset, supported);
    }

    function createRequest(RequestTerms calldata terms) external nonReentrant returns (uint256 requestTokenId) {
        Profile storage creatorProfile = profiles[msg.sender];
        require(creatorProfile.emailHash != bytes32(0), "Creator profile is required");
        require(supportedAssets[terms.asset], "Asset is not supported");
        require(terms.principal > 0, "Principal is required");
        require(terms.repaymentAmount >= terms.principal, "Repayment below principal");
        require(
            terms.repaymentAmount - terms.principal <= Math.mulDiv(terms.principal, MAX_FEE_BPS, BPS_DENOMINATOR),
            "Fee exceeds cap"
        );
        require(terms.fundingDeadline > block.timestamp, "Funding deadline passed");
        require(terms.repaymentDueAt > terms.fundingDeadline, "Invalid repayment deadline");
        require(terms.termsHash != bytes32(0), "Terms hash is required");
        _requireIpfsUri(terms.metadataUri);
        _requireHttpsUrl(terms.artizenProjectUrl);
        _requireHttpsUrl(terms.artizenFundUrl);

        requestTokenId = ++tokenCount;
        requests[requestTokenId] = AdvanceRequest({
            creator: msg.sender,
            creatorEmailHash: creatorProfile.emailHash,
            asset: terms.asset,
            principal: terms.principal,
            repaymentAmount: terms.repaymentAmount,
            createdAt: uint64(block.timestamp),
            fundingDeadline: terms.fundingDeadline,
            repaymentDueAt: terms.repaymentDueAt,
            termsHash: terms.termsHash,
            metadataUri: terms.metadataUri,
            artizenProjectUrl: terms.artizenProjectUrl,
            artizenFundUrl: terms.artizenFundUrl,
            advanceId: 0
        });
        tokenRecords[requestTokenId] = TokenRecord(TokenKind.Request, requestTokenId, 0);
        _creatorRequestTokenIds[msg.sender].push(requestTokenId);
        _emailRequestTokenIds[creatorProfile.emailHash].push(requestTokenId);
        ++walletStats[msg.sender].requestsCreated;
        ++emailStats[creatorProfile.emailHash].requestsCreated;
        _safeMint(msg.sender, requestTokenId);
        emit AdvanceRequested(
            requestTokenId,
            msg.sender,
            terms.asset,
            terms.principal,
            terms.repaymentAmount,
            terms.fundingDeadline,
            terms.repaymentDueAt,
            terms.termsHash,
            terms.metadataUri,
            terms.artizenProjectUrl,
            terms.artizenFundUrl
        );
    }

    function fundRequest(uint256 requestTokenId, string calldata metadataUri)
        external payable nonReentrant returns (uint256 advanceId)
    {
        AdvanceRequest storage request = requests[requestTokenId];
        require(request.creator != address(0), "Request does not exist");
        require(request.advanceId == 0, "Request already funded");
        require(block.timestamp <= request.fundingDeadline, "Request expired");
        require(supportedAssets[request.asset], "Asset is not supported");
        require(msg.sender != request.creator, "Creator cannot fund own request");
        Profile storage sponsorProfile = profiles[msg.sender];
        require(sponsorProfile.emailHash != bytes32(0), "Sponsor profile is required");
        _requireIpfsUri(metadataUri);

        advanceId = ++advanceCount;
        uint256 offerTokenId = ++tokenCount;
        request.advanceId = advanceId;
        advances[advanceId] = Advance({
            requestTokenId: requestTokenId,
            offerTokenId: offerTokenId,
            sponsor: msg.sender,
            beneficiary: address(0),
            settlementRecipient: address(0),
            fundedAt: uint64(block.timestamp),
            acceptedAt: 0,
            closedAt: 0,
            recoveredAmount: 0,
            creatorPayout: 0,
            status: AdvanceStatus.Funded,
            metadataUri: metadataUri
        });
        tokenRecords[requestTokenId].advanceId = advanceId;
        tokenRecords[offerTokenId] = TokenRecord(TokenKind.Offer, requestTokenId, advanceId);
        totalLiabilities[request.asset] += request.principal;
        _lenderAdvanceIds[msg.sender].push(advanceId);
        _emailLenderAdvanceIds[sponsorProfile.emailHash].push(advanceId);
        ++walletStats[msg.sender].offersFunded;
        ++emailStats[sponsorProfile.emailHash].offersFunded;
        walletAssetStats[msg.sender][request.asset].principalFunded += request.principal;
        emailAssetStats[sponsorProfile.emailHash][request.asset].principalFunded += request.principal;

        _collect(request.asset, msg.sender, request.principal);
        _safeMint(msg.sender, offerTokenId);
        emit AdvanceFunded(advanceId, requestTokenId, offerTokenId, msg.sender, metadataUri);
    }

    function acceptOffer(uint256 advanceId) external nonReentrant {
        Advance storage advance = advances[advanceId];
        AdvanceRequest storage request = requests[advance.requestTokenId];
        require(advance.status == AdvanceStatus.Funded, "Offer is not funded");
        require(msg.sender == request.creator, "Only creator can accept");
        require(block.timestamp <= request.fundingDeadline, "Offer expired");
        advance.status = AdvanceStatus.Active;
        advance.acceptedAt = uint64(block.timestamp);
        totalLiabilities[request.asset] -= request.principal;
        ++walletStats[request.creator].advancesAccepted;
        ++emailStats[request.creatorEmailHash].advancesAccepted;
        walletAssetStats[request.creator][request.asset].principalBorrowed += request.principal;
        emailAssetStats[request.creatorEmailHash][request.asset].principalBorrowed += request.principal;
        _pay(request.asset, request.creator, request.principal);
        emit AdvanceAccepted(advanceId, request.creator);
    }

    function setSettlementRecipient(uint256 advanceId, address destination) external {
        Advance storage advance = advances[advanceId];
        require(advance.status == AdvanceStatus.Active, "Advance is not active");
        require(ownerOf(advance.offerTokenId) == msg.sender, "Only offer owner can set destination");
        require(destination != address(0), "Destination is required");
        advance.settlementRecipient = destination;
        emit SettlementDestinationUpdated(advanceId, destination);
    }

    function repay(uint256 advanceId) external payable nonReentrant {
        Advance storage advance = advances[advanceId];
        AdvanceRequest storage request = requests[advance.requestTokenId];
        require(advance.status == AdvanceStatus.Active, "Advance is not active");
        require(msg.sender == request.creator, "Only creator can repay");
        // Late repayment remains available until a settlement closes the advance.
        address beneficiary = ownerOf(advance.offerTokenId);
        address destination = advance.settlementRecipient == address(0) ? beneficiary : advance.settlementRecipient;
        _closeAdvance(advance, request, AdvanceStatus.Repaid, beneficiary, request.repaymentAmount, 0);
        _collect(request.asset, msg.sender, request.repaymentAmount);
        _pay(request.asset, destination, request.repaymentAmount);
        emit AdvanceRepaid(advanceId, beneficiary, request.repaymentAmount);
    }

    function settleFromPayout(uint256 advanceId, uint256 grossPayout)
        external payable onlyRole(SETTLEMENT_ROLE) nonReentrant
    {
        Advance storage advance = advances[advanceId];
        AdvanceRequest storage request = requests[advance.requestTokenId];
        require(advance.status == AdvanceStatus.Active, "Advance is not active");
        require(grossPayout > 0, "Payout is required");
        uint256 recoveredAmount = Math.min(grossPayout, request.repaymentAmount);
        uint256 creatorPayout = grossPayout - recoveredAmount;
        bool defaulted = recoveredAmount < request.repaymentAmount;
        address beneficiary = ownerOf(advance.offerTokenId);
        address destination = advance.settlementRecipient == address(0) ? beneficiary : advance.settlementRecipient;
        _closeAdvance(
            advance,
            request,
            defaulted ? AdvanceStatus.Defaulted : AdvanceStatus.Settled,
            beneficiary,
            recoveredAmount,
            creatorPayout
        );
        _collect(request.asset, msg.sender, grossPayout);
        _pay(request.asset, destination, recoveredAmount);
        if (creatorPayout > 0) _pay(request.asset, request.creator, creatorPayout);
        emit AdvanceSettled(advanceId, beneficiary, recoveredAmount, creatorPayout, defaulted);
    }

    function cancelOffer(uint256 advanceId) external nonReentrant {
        Advance storage advance = advances[advanceId];
        AdvanceRequest storage request = requests[advance.requestTokenId];
        require(advance.status == AdvanceStatus.Funded, "Offer is not funded");
        address beneficiary = ownerOf(advance.offerTokenId);
        require(msg.sender == beneficiary, "Only offer owner can cancel");
        advance.status = AdvanceStatus.Cancelled;
        advance.beneficiary = beneficiary;
        advance.closedAt = uint64(block.timestamp);
        totalLiabilities[request.asset] -= request.principal;
        _pay(request.asset, beneficiary, request.principal);
        emit AdvanceCancelled(advanceId, beneficiary);
    }

    function expireOffer(uint256 advanceId) external nonReentrant {
        Advance storage advance = advances[advanceId];
        AdvanceRequest storage request = requests[advance.requestTokenId];
        require(advance.status == AdvanceStatus.Funded, "Offer is not funded");
        require(block.timestamp > request.fundingDeadline, "Offer has not expired");
        address beneficiary = ownerOf(advance.offerTokenId);
        advance.status = AdvanceStatus.Expired;
        advance.beneficiary = beneficiary;
        advance.closedAt = uint64(block.timestamp);
        totalLiabilities[request.asset] -= request.principal;
        _pay(request.asset, beneficiary, request.principal);
        emit AdvanceExpired(advanceId, beneficiary);
    }

    function submitOutcome(uint256 advanceId, uint8 rating, bytes32 outcomeHash, string calldata metadataUri)
        external
    {
        Advance storage advance = advances[advanceId];
        AdvanceRequest storage request = requests[advance.requestTokenId];
        require(_isTerminal(advance.status), "Advance is not complete");
        require(msg.sender == request.creator || msg.sender == advance.beneficiary, "Not an outcome participant");
        require(_outcomes[advanceId][msg.sender].submittedAt == 0, "Outcome already submitted");
        require(rating >= 1 && rating <= 5, "Rating must be 1-5");
        require(outcomeHash != bytes32(0), "Outcome hash is required");
        _requireIpfsUri(metadataUri);
        _outcomes[advanceId][msg.sender] = OutcomeAttestation(
            rating, outcomeHash, metadataUri, uint64(block.timestamp)
        );
        Profile storage profile = profiles[msg.sender];
        ++walletStats[msg.sender].outcomesSubmitted;
        ++emailStats[profile.emailHash].outcomesSubmitted;
        emit OutcomeSubmitted(advanceId, msg.sender, rating, outcomeHash, metadataUri);
        if (
            _outcomes[advanceId][request.creator].submittedAt != 0 &&
            _outcomes[advanceId][advance.beneficiary].submittedAt != 0
        ) emit OutcomeFinalized(advanceId, request.creator, advance.beneficiary);
        emit MetadataUpdate(msg.sender == request.creator ? advance.requestTokenId : advance.offerTokenId);
    }

    function recoverUnencumberedFunds(address asset, address recipient, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant
    {
        require(recipient != address(0), "Recipient is required");
        require(amount > 0, "Amount is required");
        uint256 balance = _assetBalance(asset);
        require(balance >= totalLiabilities[asset], "Liabilities exceed balance");
        require(amount <= balance - totalLiabilities[asset], "Funds are encumbered");
        _pay(asset, recipient, amount);
        emit UnencumberedFundsRecovered(asset, recipient, amount);
    }

    function creatorRequestTokenIds(address creator) external view returns (uint256[] memory) {
        return _creatorRequestTokenIds[creator];
    }

    function lenderAdvanceIds(address lender) external view returns (uint256[] memory) {
        return _lenderAdvanceIds[lender];
    }

    function emailRequestTokenIds(bytes32 emailHash) external view returns (uint256[] memory) {
        return _emailRequestTokenIds[emailHash];
    }

    function emailLenderAdvanceIds(bytes32 emailHash) external view returns (uint256[] memory) {
        return _emailLenderAdvanceIds[emailHash];
    }

    function outcome(uint256 advanceId, address participant) external view returns (OutcomeAttestation memory) {
        return _outcomes[advanceId][participant];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        TokenRecord storage record = tokenRecords[tokenId];
        AdvanceRequest storage request = requests[record.requestTokenId];
        if (record.kind == TokenKind.Request) {
            OutcomeAttestation storage creatorOutcome = _outcomes[record.advanceId][request.creator];
            return creatorOutcome.submittedAt == 0 ? request.metadataUri : creatorOutcome.metadataUri;
        }
        Advance storage advance = advances[record.advanceId];
        address beneficiary = advance.beneficiary == address(0) ? ownerOf(tokenId) : advance.beneficiary;
        OutcomeAttestation storage beneficiaryOutcome = _outcomes[record.advanceId][beneficiary];
        return beneficiaryOutcome.submittedAt == 0 ? advance.metadataUri : beneficiaryOutcome.metadataUri;
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, AccessControl, IERC165) returns (bool)
    {
        return interfaceId == type(IERC4906).interfaceId || super.supportsInterface(interfaceId);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            TokenRecord storage record = tokenRecords[tokenId];
            require(record.kind == TokenKind.Offer, "Request NFT is non-transferable");
            Advance storage advance = advances[record.advanceId];
            require(advance.status == AdvanceStatus.Active, "Offer NFT transfers require active advance");
            require(profiles[to].emailHash != bytes32(0), "Recipient profile is required");
            if (advance.settlementRecipient != address(0)) {
                advance.settlementRecipient = address(0);
                emit SettlementDestinationUpdated(record.advanceId, address(0));
            }
        }
        return super._update(to, tokenId, auth);
    }

    function _closeAdvance(
        Advance storage advance,
        AdvanceRequest storage request,
        AdvanceStatus status,
        address beneficiary,
        uint256 recoveredAmount,
        uint256 creatorPayout
    ) internal {
        advance.status = status;
        advance.beneficiary = beneficiary;
        advance.closedAt = uint64(block.timestamp);
        advance.recoveredAmount = recoveredAmount;
        advance.creatorPayout = creatorPayout;
        ++walletStats[request.creator].advancesCompleted;
        ++emailStats[request.creatorEmailHash].advancesCompleted;
        Profile storage beneficiaryProfile = profiles[beneficiary];
        ++walletStats[beneficiary].advancesCompleted;
        ++emailStats[beneficiaryProfile.emailHash].advancesCompleted;
        if (status == AdvanceStatus.Defaulted) {
            ++walletStats[request.creator].defaults;
            ++emailStats[request.creatorEmailHash].defaults;
        }
        walletAssetStats[request.creator][request.asset].amountRepaid += recoveredAmount;
        emailAssetStats[request.creatorEmailHash][request.asset].amountRepaid += recoveredAmount;
        walletAssetStats[beneficiary][request.asset].amountRecovered += recoveredAmount;
        emailAssetStats[beneficiaryProfile.emailHash][request.asset].amountRecovered += recoveredAmount;
        walletAssetStats[request.creator][request.asset].creatorPayouts += creatorPayout;
        emailAssetStats[request.creatorEmailHash][request.asset].creatorPayouts += creatorPayout;
    }

    function _collect(address asset, address from, uint256 amount) internal {
        if (asset == address(0)) {
            require(msg.value == amount, "Incorrect native value");
            return;
        }
        require(msg.value == 0, "Native value not accepted for token asset");
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(from, address(this), amount);
        require(IERC20(asset).balanceOf(address(this)) - balanceBefore == amount, "Unsupported token transfer fee");
    }

    function _pay(address asset, address recipient, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == address(0)) {
            (bool success, ) = payable(recipient).call{value: amount}("");
            require(success, "Native transfer failed");
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }
    }

    function _assetBalance(address asset) internal view returns (uint256) {
        return asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    function _isTerminal(AdvanceStatus status) internal pure returns (bool) {
        return status == AdvanceStatus.Repaid || status == AdvanceStatus.Settled ||
            status == AdvanceStatus.Cancelled || status == AdvanceStatus.Expired ||
            status == AdvanceStatus.Defaulted;
    }

    function _requireHttpsUrl(string calldata value) internal pure {
        bytes calldata data = bytes(value);
        require(data.length > 8, "HTTPS URL is required");
        require(
            data[0] == "h" && data[1] == "t" && data[2] == "t" && data[3] == "p" &&
            data[4] == "s" && data[5] == ":" && data[6] == "/" && data[7] == "/",
            "HTTPS URL is required"
        );
        for (uint256 index = 8; index < data.length; ++index) {
            require(data[index] >= 0x20 && data[index] != 0x22 && data[index] != 0x5c, "Unsafe URL character");
        }
    }

    function _requireIpfsUri(string calldata value) internal pure {
        bytes calldata data = bytes(value);
        require(data.length > 15, "IPFS URI is required");
        require(
            data[0] == "i" && data[1] == "p" && data[2] == "f" && data[3] == "s" &&
            data[4] == ":" && data[5] == "/" && data[6] == "/",
            "IPFS URI is required"
        );
        for (uint256 index = 7; index < data.length; ++index) {
            require(data[index] > 0x20 && data[index] != 0x22 && data[index] != 0x5c, "Unsafe URI character");
        }
    }
}