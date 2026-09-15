// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./ANIVRegistry.sol";
import "./ANIVTypes.sol";

contract InitiationVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdcToken;
    ANIVRegistry public registry;
    address public artizenSettlementRouter;

    uint256 public constant MAX_ADVANCE_CAP = 250 * 10 ** 6;
    uint256 public totalLoansDisbursed;
    uint256 public totalLoansRepaid;

    mapping(address => ANIVTypes.Loan) public activeLoans;
    mapping(uint256 => ANIVTypes.CreatorApplication) public applications;
    uint256 public applicationCounter;

    event ApplicationSubmitted(
        uint256 indexed appId,
        address indexed creator,
        uint256 amount
    );
    event AdvanceDisbursed(
        address indexed creator,
        address indexed welcomer,
        uint256 amount
    );
    event LoanSettled(
        address indexed creator,
        uint256 amountRepaid,
        uint256 remainingPayout
    );
    event LoanDefaulted(address indexed creator, uint256 unpaidAmount);

    modifier onlyWelcomer() {
        require(
            registry.hasRole(registry.WELCOMER_ROLE(), msg.sender),
            "Caller is not a registered Welcomer"
        );
        _;
    }

    modifier onlySettlementRouter() {
        require(
            msg.sender == artizenSettlementRouter,
            "Caller is not Settlement Router"
        );
        _;
    }

    constructor(
        address _usdcToken,
        address _registry,
        address _settlementRouter
    ) {
        usdcToken = IERC20(_usdcToken);
        registry = ANIVRegistry(_registry);
        artizenSettlementRouter = _settlementRouter;
    }

    function submitApplication(
        uint256 _requestedAmount,
        string calldata _category,
        string calldata _ipfsExpenseDetailsHash
    ) external returns (uint256) {
        require(
            registry.isEligibleFirstTimer(msg.sender),
            "Creator not eligible for first-timer advance"
        );
        require(
            _requestedAmount > 0 && _requestedAmount <= MAX_ADVANCE_CAP,
            "Invalid requested amount"
        );

        applicationCounter++;
        applications[applicationCounter] = ANIVTypes.CreatorApplication({
            applicationId: applicationCounter,
            creatorAddress: msg.sender,
            requestedAmount: _requestedAmount,
            category: _category,
            ipfsExpenseDetailsHash: _ipfsExpenseDetailsHash,
            timestamp: block.timestamp,
            status: ANIVTypes.LoanStatus.Applied
        });

        emit ApplicationSubmitted(applicationCounter, msg.sender, _requestedAmount);
        return applicationCounter;
    }

    function approveAndDisburse(uint256 _applicationId)
        external
        onlyWelcomer
        nonReentrant
    {
        ANIVTypes.CreatorApplication storage app = applications[_applicationId];
        require(
            app.status == ANIVTypes.LoanStatus.Applied,
            "Application not in pending state"
        );
        require(
            registry.isEligibleFirstTimer(app.creatorAddress),
            "Creator already received advance"
        );
        require(
            usdcToken.balanceOf(address(this)) >= app.requestedAmount,
            "Insufficient vault liquidity"
        );

        app.status = ANIVTypes.LoanStatus.Approved;
        registry.recordAdvanceIssued(app.creatorAddress);

        activeLoans[app.creatorAddress] = ANIVTypes.Loan({
            loanId: _applicationId,
            creator: app.creatorAddress,
            assignedWelcomer: msg.sender,
            principalUSDC: app.requestedAmount,
            timestampDisbursed: block.timestamp,
            isSettled: false,
            isDefaulted: false
        });

        totalLoansDisbursed += app.requestedAmount;
        app.status = ANIVTypes.LoanStatus.Active;

        usdcToken.safeTransfer(app.creatorAddress, app.requestedAmount);
        emit AdvanceDisbursed(app.creatorAddress, msg.sender, app.requestedAmount);
    }

    function settleSeasonPayout(address _creator, uint256 _totalSeasonPayout)
        external
        onlySettlementRouter
        nonReentrant
        returns (uint256 netPayoutToCreator)
    {
        ANIVTypes.Loan storage loan = activeLoans[_creator];

        if (loan.principalUSDC == 0 || loan.isSettled) {
            return _totalSeasonPayout;
        }

        uint256 repaymentAmount = loan.principalUSDC;

        if (_totalSeasonPayout >= repaymentAmount) {
            netPayoutToCreator = _totalSeasonPayout - repaymentAmount;
            loan.isSettled = true;
            totalLoansRepaid += repaymentAmount;
            emit LoanSettled(_creator, repaymentAmount, netPayoutToCreator);
        } else {
            repaymentAmount = _totalSeasonPayout;
            netPayoutToCreator = 0;
            loan.isDefaulted = true;
            loan.isSettled = true;
            totalLoansRepaid += repaymentAmount;
            emit LoanDefaulted(_creator, loan.principalUSDC - repaymentAmount);
        }

        return netPayoutToCreator;
    }
}
