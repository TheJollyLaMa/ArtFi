// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IArtFiProfileReader {
    function profiles(address account)
        external
        view
        returns (bytes32 emailHash, bytes32 agentDidHash, string memory profileUri);
}

interface IArtFiRewardRouter {
    function PAYROLL_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function approvedAssets(address asset) external view returns (bool);
    function funds(bytes32 fundId) external view returns (string memory metadataUri, bool active, bool exists);
    function isApprovedRecipient(address wallet) external view returns (bool);
    function payout(
        bytes32 fundId,
        address asset,
        address payable recipient,
        uint256 amount,
        bytes32 workReference,
        bytes32 repositoryIdHash,
        bytes32 contributorIdHash,
        string calldata metadataUri,
        bytes32 metadataHash
    ) external;
}

contract ArtFiNetworkRegistry is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant NETWORK_ADMIN_ROLE = keccak256("NETWORK_ADMIN_ROLE");
    bytes32 public constant NODE_CHECKER_ROLE = keccak256("NODE_CHECKER_ROLE");
    uint256 public constant MONTHLY_NODE_REWARD = 10 ether;
    uint256 public constant HEARTBEAT_INTERVAL = 12 hours;
    uint256 public constant MIN_MONTHLY_CHECKS = 25;

    enum ContentKind { Profile, Request, Offer, Outcome }

    struct Publication {
        address publisher;
        ContentKind kind;
        string cid;
        bytes32 contentHash;
        bytes32 agentDidHash;
        bytes32 statusHash;
        uint64 publishedAt;
        bool active;
    }

    struct Node {
        address operator;
        bytes32 nodeDidHash;
        bytes32 peerIdHash;
        string softwareVersion;
        bool approved;
        bool active;
    }

    struct MonthStats {
        uint32 checks;
        uint32 checkerChecks;
        uint64 firstHeartbeat;
        uint64 lastHeartbeat;
        bytes32 lastSampleProofHash;
        bool rewardPaid;
    }

    IArtFiProfileReader public immutable profileReader;
    uint256 public publicationCount;
    uint256 public nodeCount;
    mapping(uint256 => Publication) public publications;
    mapping(address => uint256[]) private _publisherPublications;
    mapping(uint256 => Node) public nodes;
    mapping(address => uint256[]) private _operatorNodes;
    mapping(uint256 => mapping(uint256 => MonthStats)) public monthStats;
    mapping(uint256 => bytes32) public monthChallenges;
    IArtFiRewardRouter public nodeRewardRouter;
    bytes32 public nodeRewardFundId;
    address public nodeRewardAsset;
    uint256 public nodeRewardAmount;

    event ContentPublished(
        uint256 indexed publicationId,
        address indexed publisher,
        ContentKind indexed kind,
        string cid,
        bytes32 contentHash,
        bytes32 agentDidHash,
        bytes32 statusHash,
        uint256 publishedAt,
        string artizenProjectUrl,
        string artizenFundUrl
    );
    event ContentDeactivated(uint256 indexed publicationId, address indexed publisher);
    event ContentStatusUpdated(uint256 indexed publicationId, bytes32 indexed statusHash, uint256 timestamp);
    event NodeRegistered(
        uint256 indexed nodeId,
        address indexed operator,
        bytes32 nodeDidHash,
        bytes32 peerIdHash,
        string softwareVersion
    );
    event NodeApprovalUpdated(uint256 indexed nodeId, bool approved);
    event NodeHeartbeat(
        uint256 indexed nodeId,
        uint256 indexed month,
        bytes32 challengeHash,
        bytes32 sampleProofHash,
        uint256 sampleCount,
        uint256 timestamp
    );
    event NodeCheckRecorded(
        uint256 indexed nodeId,
        uint256 indexed month,
        address indexed checker,
        bytes32 challengeHash,
        bytes32 sampleProofHash,
        uint256 sampleCount,
        uint256 timestamp
    );
    event MonthlyNodeRewardRecorded(
        uint256 indexed nodeId,
        uint256 indexed month,
        address indexed operator,
        uint256 amount,
        bytes32 paymentReference
    );
    event NodeRewardPayoutConfigured(address indexed router, bytes32 indexed fundId, address indexed asset, uint256 amount);
    event UnencumberedFundsRecovered(address indexed asset, address indexed recipient, uint256 amount);

    constructor(address profileContract, address defaultAdmin) {
        require(profileContract != address(0), "Profile contract is required");
        require(defaultAdmin != address(0), "Admin is required");
        profileReader = IArtFiProfileReader(profileContract);
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(NETWORK_ADMIN_ROLE, defaultAdmin);
        _grantRole(NODE_CHECKER_ROLE, defaultAdmin);
    }

    function publishContent(
        ContentKind kind,
        string calldata cid,
        bytes32 contentHash,
        bytes32 agentDidHash,
        string calldata artizenProjectUrl,
        string calldata artizenFundUrl
    ) external returns (uint256 publicationId) {
        (, bytes32 registeredAgentDidHash, ) = profileReader.profiles(msg.sender);
        require(registeredAgentDidHash != bytes32(0), "Profile is not registered");
        require(agentDidHash == registeredAgentDidHash, "Agent DID hash does not match profile");
        require(contentHash != bytes32(0), "Content hash is required");
        _requireIpfsUri(cid);
        _requireHttpsUrl(artizenProjectUrl);
        _requireHttpsUrl(artizenFundUrl);

        publicationId = ++publicationCount;
        publications[publicationId] = Publication({
            publisher: msg.sender,
            kind: kind,
            cid: cid,
            contentHash: contentHash,
            agentDidHash: agentDidHash,
            statusHash: ethersHash("published"),
            publishedAt: uint64(block.timestamp),
            active: true
        });
        _publisherPublications[msg.sender].push(publicationId);
        emit ContentPublished(
            publicationId,
            msg.sender,
            kind,
            cid,
            contentHash,
            agentDidHash,
            ethersHash("published"),
            block.timestamp,
            artizenProjectUrl,
            artizenFundUrl
        );
    }

    function deactivateContent(uint256 publicationId) external {
        Publication storage publication = publications[publicationId];
        require(publication.publisher == msg.sender, "Only publisher can deactivate");
        require(publication.active, "Content is inactive");
        publication.active = false;
        emit ContentDeactivated(publicationId, msg.sender);
    }

    function updateContentStatus(uint256 publicationId, bytes32 statusHash) external {
        Publication storage publication = publications[publicationId];
        require(publication.publisher == msg.sender, "Only publisher can update");
        require(publication.active, "Content is inactive");
        require(statusHash != bytes32(0), "Status hash is required");
        publication.statusHash = statusHash;
        emit ContentStatusUpdated(publicationId, statusHash, block.timestamp);
    }

    function publisherPublicationIds(address publisher) external view returns (uint256[] memory) {
        return _publisherPublications[publisher];
    }

    function registerNode(bytes32 nodeDidHash, bytes32 peerIdHash, string calldata softwareVersion)
        external
        returns (uint256 nodeId)
    {
        require(nodeDidHash != bytes32(0), "Node DID hash is required");
        require(peerIdHash != bytes32(0), "Peer ID hash is required");
        require(bytes(softwareVersion).length > 0, "Software version is required");
        nodeId = ++nodeCount;
        nodes[nodeId] = Node(msg.sender, nodeDidHash, peerIdHash, softwareVersion, false, true);
        _operatorNodes[msg.sender].push(nodeId);
        emit NodeRegistered(nodeId, msg.sender, nodeDidHash, peerIdHash, softwareVersion);
    }

    function setNodeApproval(uint256 nodeId, bool approved) external onlyRole(NETWORK_ADMIN_ROLE) {
        require(nodes[nodeId].operator != address(0), "Node does not exist");
        nodes[nodeId].approved = approved;
        emit NodeApprovalUpdated(nodeId, approved);
    }

    function setNodeActive(uint256 nodeId, bool active) external {
        require(nodes[nodeId].operator == msg.sender, "Only node operator can change status");
        nodes[nodeId].active = active;
    }

    function operatorNodeIds(address operator) external view returns (uint256[] memory) {
        return _operatorNodes[operator];
    }

    function setMonthChallenge(uint256 month, bytes32 challengeHash)
        external
        onlyRole(NETWORK_ADMIN_ROLE)
    {
        require(challengeHash != bytes32(0), "Challenge is required");
        monthChallenges[month] = challengeHash;
    }

    function heartbeat(
        uint256 nodeId,
        uint256 month,
        bytes32 challengeHash,
        bytes32 sampleProofHash,
        uint256 sampleCount,
        string calldata softwareVersion
    ) external {
        Node storage node = nodes[nodeId];
        require(node.operator == msg.sender, "Only node operator can heartbeat");
        _recordNodeCheck(nodeId, month, challengeHash, sampleProofHash, sampleCount, false);
        node.softwareVersion = softwareVersion;
        emit NodeHeartbeat(nodeId, month, challengeHash, sampleProofHash, sampleCount, block.timestamp);
    }

    function recordNodeCheck(
        uint256 nodeId,
        uint256 month,
        bytes32 challengeHash,
        bytes32 sampleProofHash,
        uint256 sampleCount
    ) external onlyRole(NODE_CHECKER_ROLE) {
        require(msg.sender != nodes[nodeId].operator, "Node operator cannot check own node");
        _recordNodeCheck(nodeId, month, challengeHash, sampleProofHash, sampleCount, true);
        emit NodeCheckRecorded(nodeId, month, msg.sender, challengeHash, sampleProofHash, sampleCount, block.timestamp);
    }

    function _recordNodeCheck(
        uint256 nodeId,
        uint256 month,
        bytes32 challengeHash,
        bytes32 sampleProofHash,
        uint256 sampleCount,
        bool independentCheck
    ) internal {
        Node storage node = nodes[nodeId];
        require(node.approved && node.active, "Node is not approved and active");
        require(monthChallenges[month] == challengeHash, "Challenge does not match");
        require(sampleProofHash != bytes32(0), "Sample proof is required");
        require(sampleCount > 0, "Sample count is required");
        MonthStats storage stats = monthStats[nodeId][month];
        require(stats.lastHeartbeat == 0 || block.timestamp >= stats.lastHeartbeat + HEARTBEAT_INTERVAL, "Heartbeat too soon");
        if (stats.firstHeartbeat == 0) stats.firstHeartbeat = uint64(block.timestamp);
        stats.lastHeartbeat = uint64(block.timestamp);
        stats.lastSampleProofHash = sampleProofHash;
        ++stats.checks;
        if (independentCheck) ++stats.checkerChecks;
    }

    function rewardEligible(uint256 nodeId, uint256 month) public view returns (bool) {
        MonthStats storage stats = monthStats[nodeId][month];
        Node storage node = nodes[nodeId];
        return node.approved && node.active && stats.checkerChecks >= MIN_MONTHLY_CHECKS &&
            stats.lastSampleProofHash != bytes32(0) && !stats.rewardPaid;
    }

    function setNodeRewardPayout(address routerAddress, bytes32 fundId, address asset, uint256 amount)
        external
        onlyRole(NETWORK_ADMIN_ROLE)
    {
        require(routerAddress.code.length > 0, "Reward router is not a contract");
        require(fundId != bytes32(0), "Reward fund is required");
        require(amount > 0, "Reward amount is required");
        IArtFiRewardRouter router = IArtFiRewardRouter(routerAddress);
        require(router.approvedAssets(asset), "Reward asset is not approved on router");
        (, bool active, bool exists) = router.funds(fundId);
        require(exists && active, "Reward fund is not active on router");
        require(router.hasRole(router.PAYROLL_ROLE(), address(this)), "Registry needs PAYROLL_ROLE on router");

        nodeRewardRouter = router;
        nodeRewardFundId = fundId;
        nodeRewardAsset = asset;
        nodeRewardAmount = amount;
        emit NodeRewardPayoutConfigured(routerAddress, fundId, asset, amount);
    }

    function markMonthlyRewardPaid(uint256 nodeId, uint256 month) external onlyRole(NETWORK_ADMIN_ROLE) nonReentrant {
        require(rewardEligible(nodeId, month), "Node is not reward eligible");
        require(address(nodeRewardRouter) != address(0), "Node reward payout is not configured");
        Node storage node = nodes[nodeId];
        require(nodeRewardRouter.isApprovedRecipient(node.operator), "Node operator is not whitelisted on router");

        bytes32 workReference = keccak256(abi.encode(
            "ARTFI_NODE_REWARD_V1",
            address(this),
            nodeId,
            month,
            nodeRewardFundId,
            nodeRewardAsset
        ));
        bytes32 repositoryIdHash = keccak256(bytes("ArtFi/Network"));
        bytes32 metadataHash = keccak256(abi.encode(
            nodeId,
            month,
            node.operator,
            nodeRewardAsset,
            nodeRewardAmount,
            monthStats[nodeId][month].lastSampleProofHash
        ));

        monthStats[nodeId][month].rewardPaid = true;
        nodeRewardRouter.payout(
            nodeRewardFundId,
            nodeRewardAsset,
            payable(node.operator),
            nodeRewardAmount,
            workReference,
            repositoryIdHash,
            node.nodeDidHash,
            "",
            metadataHash
        );
        emit MonthlyNodeRewardRecorded(
            nodeId,
            month,
            node.operator,
            nodeRewardAmount,
            workReference
        );
    }

    function recoverUnencumberedFunds(address asset, address payable recipient, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        require(recipient != address(0), "Recipient is required");
        require(amount > 0, "Amount is required");
        if (asset == address(0)) {
            require(address(this).balance >= amount, "Insufficient native balance");
            (bool sent, ) = recipient.call{value: amount}("");
            require(sent, "Native recovery failed");
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }
        emit UnencumberedFundsRecovered(asset, recipient, amount);
    }

    function _requireIpfsUri(string calldata value) internal pure {
        bytes calldata data = bytes(value);
        require(data.length > 15, "IPFS URI is required");
        require(
            data[0] == "i" && data[1] == "p" && data[2] == "f" && data[3] == "s" &&
            data[4] == ":" && data[5] == "/" && data[6] == "/",
            "IPFS URI is required"
        );
    }

    function ethersHash(string memory value) internal pure returns (bytes32) {
        return keccak256(bytes(value));
    }

    function _requireHttpsUrl(string calldata value) internal pure {
        bytes calldata data = bytes(value);
        require(data.length > 8, "HTTPS URL is required");
        require(
            data[0] == "h" && data[1] == "t" && data[2] == "t" && data[3] == "p" &&
            data[4] == "s" && data[5] == ":" && data[6] == "/" && data[7] == "/",
            "HTTPS URL is required"
        );
    }
}