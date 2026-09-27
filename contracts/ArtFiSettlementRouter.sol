// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ArtFiSettlementRouter is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAYROLL_ROLE = keccak256("PAYROLL_ROLE");
    bytes32 public constant ASSET_ADMIN_ROLE = keccak256("ASSET_ADMIN_ROLE");
    bytes32 public constant CONTRIBUTOR_ADMIN_ROLE = keccak256("CONTRIBUTOR_ADMIN_ROLE");
    string public constant VERSION = "2.1.0";

    struct Fund {
        string metadataUri;
        bool active;
        bool exists;
    }

    struct Contributor {
        bytes32 githubIdHash;
        bool approved;
        bool exists;
    }

    mapping(bytes32 => Fund) public funds;
    mapping(bytes32 => mapping(address => uint256)) public fundBalances;
    mapping(address => uint256) public totalFundBalances;
    mapping(address => bool) public approvedAssets;
    mapping(address => Contributor) public contributors;
    // Global namespace: a work reference already encodes issue, contributor, and role.
    mapping(bytes32 => bool) public completedWorkReferences;
    bytes32[] private _fundIds;
    address[] private _contributorWallets;

    event FundCreated(bytes32 indexed fundId, string metadataUri);
    event FundMetadataUpdated(bytes32 indexed fundId, string metadataUri);
    event FundStatusUpdated(bytes32 indexed fundId, bool active);
    event ContributorApprovalUpdated(address indexed wallet, bytes32 indexed githubIdHash, bool approved);
    event AssetApprovalUpdated(address indexed asset, bool approved);
    event FundFunded(bytes32 indexed fundId, address indexed asset, address indexed funder, uint256 amount);
    event PayrollPaid(
        bytes32 indexed fundId,
        address indexed asset,
        address indexed recipient,
        uint256 amount,
        bytes32 workReference,
        bytes32 repositoryIdHash,
        bytes32 contributorIdHash,
        string metadataUri,
        bytes32 metadataHash
    );
    event ExcessRecovered(address indexed asset, address indexed recipient, uint256 amount);
    event FundRecovered(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount);

    constructor(address defaultAdmin) {
        require(defaultAdmin != address(0), "Admin is required");
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(PAYROLL_ROLE, defaultAdmin);
        _grantRole(ASSET_ADMIN_ROLE, defaultAdmin);
        _grantRole(CONTRIBUTOR_ADMIN_ROLE, defaultAdmin);
        approvedAssets[address(0)] = true;
        emit AssetApprovalUpdated(address(0), true);
    }

    receive() external payable {
        revert("Use fund deposits");
    }

    function createFund(bytes32 fundId, string calldata metadataUri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(fundId != bytes32(0), "Fund ID is required");
        require(!funds[fundId].exists, "Fund already exists");
        require(bytes(metadataUri).length > 0, "Fund metadata URI is required");
        funds[fundId] = Fund({metadataUri: metadataUri, active: true, exists: true});
        _fundIds.push(fundId);
        emit FundCreated(fundId, metadataUri);
    }

    function setFundActive(bytes32 fundId, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(funds[fundId].exists, "Fund does not exist");
        funds[fundId].active = active;
        emit FundStatusUpdated(fundId, active);
    }

    function setFundMetadataUri(bytes32 fundId, string calldata metadataUri)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(funds[fundId].exists, "Fund does not exist");
        require(bytes(metadataUri).length > 0, "Fund metadata URI is required");
        funds[fundId].metadataUri = metadataUri;
        emit FundMetadataUpdated(fundId, metadataUri);
    }

    function fundCount() external view returns (uint256) {
        return _fundIds.length;
    }

    function allFundIds() external view returns (bytes32[] memory) {
        return _fundIds;
    }

    function setAssetApproved(address asset, bool approved) external onlyRole(ASSET_ADMIN_ROLE) {
        if (!approved) require(totalFundBalances[asset] == 0, "Asset is allocated to a fund");
        approvedAssets[asset] = approved;
        emit AssetApprovalUpdated(asset, approved);
    }

    function setContributorApproved(address wallet, bytes32 githubIdHash, bool approved)
        public
        onlyRole(CONTRIBUTOR_ADMIN_ROLE)
    {
        require(wallet != address(0), "Wallet is required");
        if (approved) require(githubIdHash != bytes32(0), "GitHub ID hash is required");
        Contributor storage contributor = contributors[wallet];
        if (!contributor.exists) {
            contributor.exists = true;
            _contributorWallets.push(wallet);
        }
        if (githubIdHash != bytes32(0)) contributor.githubIdHash = githubIdHash;
        contributor.approved = approved;
        emit ContributorApprovalUpdated(wallet, contributor.githubIdHash, approved);
    }

    function setContributorsApproved(
        address[] calldata wallets,
        bytes32[] calldata githubIdHashes,
        bool[] calldata approvals
    ) external onlyRole(CONTRIBUTOR_ADMIN_ROLE) {
        require(
            wallets.length == githubIdHashes.length && wallets.length == approvals.length,
            "Contributor lengths do not match"
        );
        for (uint256 index; index < wallets.length; index++) {
            setContributorApproved(wallets[index], githubIdHashes[index], approvals[index]);
        }
    }

    function isApprovedRecipient(address wallet) public view returns (bool) {
        return contributors[wallet].approved;
    }

    function contributorCount() external view returns (uint256) {
        return _contributorWallets.length;
    }

    function allContributorWallets() external view returns (address[] memory) {
        return _contributorWallets;
    }

    function fundNative(bytes32 fundId) external payable whenNotPaused nonReentrant {
        _fund(fundId, address(0), msg.value, msg.sender);
    }

    function fundToken(bytes32 fundId, address asset, uint256 amount)
        external
        whenNotPaused
        nonReentrant
    {
        require(asset != address(0), "Use native funding");
        require(amount > 0, "Amount is required");
        // Credit the measured delta so fee-on-transfer tokens cannot overstate a fund.
        uint256 received = _pullToken(asset, msg.sender, amount);
        _fund(fundId, asset, received, msg.sender);
    }

    function fundTokenUnallocated(address asset, uint256 amount)
        external
        whenNotPaused
        nonReentrant
    {
        require(asset != address(0), "Use native funding");
        require(approvedAssets[asset], "Asset is not approved");
        require(amount > 0, "Amount is required");
        _pullToken(asset, msg.sender, amount);
    }

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
    ) external onlyRole(PAYROLL_ROLE) whenNotPaused nonReentrant {
        require(recipient != address(0), "Recipient is required");
        require(contributors[recipient].approved, "Recipient is not whitelisted");
        require(amount > 0, "Amount is required");
        require(workReference != bytes32(0), "Work reference is required");
        require(!completedWorkReferences[workReference], "Work already paid");
        require(funds[fundId].active, "Fund is inactive");
        require(fundBalances[fundId][asset] >= amount, "Insufficient fund balance");

        completedWorkReferences[workReference] = true;
        fundBalances[fundId][asset] -= amount;
        totalFundBalances[asset] -= amount;

        if (asset == address(0)) {
            (bool sent, ) = recipient.call{value: amount}("");
            require(sent, "Native transfer failed");
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }

        emit PayrollPaid(
            fundId,
            asset,
            recipient,
            amount,
            workReference,
            repositoryIdHash,
            contributorIdHash,
            metadataUri,
            metadataHash
        );
    }

    function payoutBatch(
        bytes32 fundId,
        address asset,
        address payable recipient,
        uint256[] calldata amounts,
        bytes32[] calldata workReferences,
        bytes32[] calldata repositoryIdHashes,
        bytes32[] calldata contributorIdHashes,
        string[] calldata metadataUris,
        bytes32[] calldata metadataHashes
    ) external onlyRole(PAYROLL_ROLE) whenNotPaused nonReentrant {
        require(recipient != address(0), "Recipient is required");
        require(contributors[recipient].approved, "Recipient is not whitelisted");
        require(funds[fundId].active, "Fund is inactive");
        require(amounts.length > 0, "Batch requires a payout");
        require(
            amounts.length == workReferences.length &&
            amounts.length == repositoryIdHashes.length &&
            amounts.length == contributorIdHashes.length &&
            amounts.length == metadataUris.length &&
            amounts.length == metadataHashes.length,
            "Batch lengths do not match"
        );

        uint256 totalAmount;
        for (uint256 index; index < amounts.length; index++) {
            require(amounts[index] > 0, "Amount is required");
            require(workReferences[index] != bytes32(0), "Work reference is required");
            require(!completedWorkReferences[workReferences[index]], "Work already paid");
            for (uint256 inner = index + 1; inner < amounts.length; inner++) {
                require(workReferences[index] != workReferences[inner], "Duplicate work reference");
            }
            totalAmount += amounts[index];
        }
        require(fundBalances[fundId][asset] >= totalAmount, "Insufficient fund balance");

        for (uint256 index; index < amounts.length; index++) {
            completedWorkReferences[workReferences[index]] = true;
            emit PayrollPaid(
                fundId,
                asset,
                recipient,
                amounts[index],
                workReferences[index],
                repositoryIdHashes[index],
                contributorIdHashes[index],
                metadataUris[index],
                metadataHashes[index]
            );
        }
        fundBalances[fundId][asset] -= totalAmount;
        totalFundBalances[asset] -= totalAmount;

        if (asset == address(0)) {
            (bool sent, ) = recipient.call{value: totalAmount}("");
            require(sent, "Native transfer failed");
        } else {
            IERC20(asset).safeTransfer(recipient, totalAmount);
        }
    }

    function payoutUnallocated(
        address asset,
        address payable recipient,
        uint256 amount,
        bytes32 workReference,
        bytes32 repositoryIdHash,
        bytes32 contributorIdHash,
        string calldata metadataUri,
        bytes32 metadataHash
    ) external onlyRole(PAYROLL_ROLE) whenNotPaused nonReentrant {
        require(recipient != address(0), "Recipient is required");
        require(contributors[recipient].approved, "Recipient is not whitelisted");
        require(amount > 0, "Amount is required");
        require(workReference != bytes32(0), "Work reference is required");
        require(approvedAssets[asset], "Asset is not approved");
        require(!completedWorkReferences[workReference], "Work already paid");

        uint256 held = asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
        require(held >= totalFundBalances[asset] + amount, "Insufficient unallocated balance");

        completedWorkReferences[workReference] = true;

        if (asset == address(0)) {
            (bool sent, ) = recipient.call{value: amount}("");
            require(sent, "Native transfer failed");
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }

        emit PayrollPaid(
            bytes32(0),
            asset,
            recipient,
            amount,
            workReference,
            repositoryIdHash,
            contributorIdHash,
            metadataUri,
            metadataHash
        );
    }

    function recoverExcess(address asset, address payable recipient, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        require(recipient != address(0), "Recipient is required");
        require(amount > 0, "Amount is required");
        uint256 held = asset == address(0) ? address(this).balance : IERC20(asset).balanceOf(address(this));
        require(held >= totalFundBalances[asset] + amount, "Amount is allocated");
        if (asset == address(0)) {
            (bool sent, ) = recipient.call{value: amount}("");
            require(sent, "Native recovery failed");
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }
        emit ExcessRecovered(asset, recipient, amount);
    }

    function recoverFund(bytes32 fundId, address asset, address payable recipient, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        require(recipient != address(0), "Recipient is required");
        require(amount > 0, "Amount is required");
        require(fundBalances[fundId][asset] >= amount, "Amount exceeds fund balance");

        fundBalances[fundId][asset] -= amount;
        totalFundBalances[asset] -= amount;
        if (asset == address(0)) {
            (bool sent, ) = recipient.call{value: amount}("");
            require(sent, "Native recovery failed");
        } else {
            IERC20(asset).safeTransfer(recipient, amount);
        }
        emit FundRecovered(fundId, asset, recipient, amount);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function _fund(bytes32 fundId, address asset, uint256 amount, address funder) internal {
        require(funds[fundId].active, "Fund is inactive");
        require(approvedAssets[asset], "Asset is not approved");
        require(amount > 0, "Amount is required");
        fundBalances[fundId][asset] += amount;
        totalFundBalances[asset] += amount;
        emit FundFunded(fundId, asset, funder, amount);
    }

    function _pullToken(address asset, address from, uint256 amount) internal returns (uint256 received) {
        IERC20 token = IERC20(asset);
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        received = token.balanceOf(address(this)) - balanceBefore;
        require(received > 0, "No tokens received");
    }
}
