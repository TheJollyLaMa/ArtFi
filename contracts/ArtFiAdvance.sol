// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract ArtFiAdvance is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    enum AdvanceStatus {
        None,
        Funded,
        Active,
        Repaid,
        Settled,
        Cancelled,
        Expired,
        Defaulted
    }

    struct Advance {
        address sponsor;
        address creator;
        uint256 principal;
        uint256 repaymentAmount;
        uint256 acceptanceDeadline;
        uint256 repaymentDueAt;
        bytes32 termsHash;
        AdvanceStatus status;
    }

    IERC20 public immutable artToken;
    uint256 public advanceCount;
    mapping(uint256 => Advance) public advances;

    event AdvanceOffered(
        uint256 indexed advanceId,
        address indexed sponsor,
        address indexed creator,
        uint256 principal,
        uint256 repaymentAmount,
        uint256 acceptanceDeadline,
        uint256 repaymentDueAt,
        bytes32 termsHash
    );
    event AdvanceAccepted(uint256 indexed advanceId, address indexed creator);
    event AdvanceRepaid(uint256 indexed advanceId, uint256 amount);
    event AdvanceSettled(
        uint256 indexed advanceId,
        uint256 recoveredAmount,
        uint256 creatorPayout,
        bool defaulted
    );
    event AdvanceCancelled(uint256 indexed advanceId);
    event AdvanceExpired(uint256 indexed advanceId);

    constructor(address token, address defaultAdmin) {
        require(token != address(0), "Token is required");
        require(defaultAdmin != address(0), "Admin is required");
        artToken = IERC20(token);
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(SETTLEMENT_ROLE, defaultAdmin);
    }

    function createOffer(
        address creator,
        uint256 principal,
        uint256 repaymentAmount,
        uint256 acceptanceDeadline,
        uint256 repaymentDueAt,
        bytes32 termsHash
    ) external nonReentrant returns (uint256 advanceId) {
        require(creator != address(0), "Creator is required");
        require(principal > 0, "Principal is required");
        require(repaymentAmount >= principal, "Repayment below principal");
        require(
            repaymentAmount - principal <= Math.mulDiv(principal, MAX_FEE_BPS, BPS_DENOMINATOR),
            "Fee exceeds cap"
        );
        require(acceptanceDeadline > block.timestamp, "Acceptance deadline passed");
        require(repaymentDueAt > acceptanceDeadline, "Invalid repayment deadline");
        require(termsHash != bytes32(0), "Terms hash is required");

        advanceId = ++advanceCount;
        advances[advanceId] = Advance({
            sponsor: msg.sender,
            creator: creator,
            principal: principal,
            repaymentAmount: repaymentAmount,
            acceptanceDeadline: acceptanceDeadline,
            repaymentDueAt: repaymentDueAt,
            termsHash: termsHash,
            status: AdvanceStatus.Funded
        });

        artToken.safeTransferFrom(msg.sender, address(this), principal);
        emit AdvanceOffered(
            advanceId,
            msg.sender,
            creator,
            principal,
            repaymentAmount,
            acceptanceDeadline,
            repaymentDueAt,
            termsHash
        );
    }

    function acceptOffer(uint256 advanceId) external nonReentrant {
        Advance storage advance = advances[advanceId];
        require(advance.status == AdvanceStatus.Funded, "Offer is not funded");
        require(msg.sender == advance.creator, "Only creator can accept");
        require(block.timestamp <= advance.acceptanceDeadline, "Offer expired");

        advance.status = AdvanceStatus.Active;
        artToken.safeTransfer(advance.creator, advance.principal);
        emit AdvanceAccepted(advanceId, advance.creator);
    }

    function repay(uint256 advanceId) external nonReentrant {
        Advance storage advance = advances[advanceId];
        require(advance.status == AdvanceStatus.Active, "Advance is not active");
        require(msg.sender == advance.creator, "Only creator can repay");

        advance.status = AdvanceStatus.Repaid;
        artToken.safeTransferFrom(msg.sender, advance.sponsor, advance.repaymentAmount);
        emit AdvanceRepaid(advanceId, advance.repaymentAmount);
    }

    function settleFromPayout(uint256 advanceId, uint256 grossPayout)
        external
        onlyRole(SETTLEMENT_ROLE)
        nonReentrant
    {
        Advance storage advance = advances[advanceId];
        require(advance.status == AdvanceStatus.Active, "Advance is not active");
        require(grossPayout > 0, "Payout is required");

        uint256 recoveredAmount = Math.min(grossPayout, advance.repaymentAmount);
        uint256 creatorPayout = grossPayout - recoveredAmount;
        bool defaulted = recoveredAmount < advance.repaymentAmount;
        advance.status = defaulted ? AdvanceStatus.Defaulted : AdvanceStatus.Settled;

        artToken.safeTransferFrom(msg.sender, address(this), grossPayout);
        artToken.safeTransfer(advance.sponsor, recoveredAmount);
        if (creatorPayout > 0) artToken.safeTransfer(advance.creator, creatorPayout);

        emit AdvanceSettled(advanceId, recoveredAmount, creatorPayout, defaulted);
    }

    function cancelOffer(uint256 advanceId) external nonReentrant {
        Advance storage advance = advances[advanceId];
        require(advance.status == AdvanceStatus.Funded, "Offer is not funded");
        require(msg.sender == advance.sponsor, "Only sponsor can cancel");

        advance.status = AdvanceStatus.Cancelled;
        artToken.safeTransfer(advance.sponsor, advance.principal);
        emit AdvanceCancelled(advanceId);
    }

    function expireOffer(uint256 advanceId) external nonReentrant {
        Advance storage advance = advances[advanceId];
        require(advance.status == AdvanceStatus.Funded, "Offer is not funded");
        require(block.timestamp > advance.acceptanceDeadline, "Offer has not expired");

        advance.status = AdvanceStatus.Expired;
        artToken.safeTransfer(advance.sponsor, advance.principal);
        emit AdvanceExpired(advanceId);
    }
}