// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "./ANIVTypes.sol";

contract ANIVRegistry is AccessControl {
    bytes32 public constant WELCOMER_ROLE = keccak256("WELCOMER_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    mapping(address => bool) public isFirstTimeCreator;
    mapping(address => bool) public hasReceivedAdvance;
    mapping(address => ANIVTypes.WelcomerProfile) public welcomers;

    event WelcomerRegistered(address indexed welcomer, string handle);
    event WelcomerStatusUpdated(address indexed welcomer, bool isActive);
    event CreatorBlacklisted(address indexed creator, string reason);

    constructor(address defaultAdmin) {
        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(ADMIN_ROLE, defaultAdmin);
    }

    function registerWelcomer(
        address _welcomer,
        string calldata _handle
    ) external onlyRole(ADMIN_ROLE) {
        _grantRole(WELCOMER_ROLE, _welcomer);
        welcomers[_welcomer] = ANIVTypes.WelcomerProfile({
            welcomerAddress: _welcomer,
            handle: _handle,
            isActive: true,
            totalCasesHandled: 0,
            successfulSettlements: 0
        });
        emit WelcomerRegistered(_welcomer, _handle);
    }

    function setWelcomerStatus(
        address _welcomer,
        bool _isActive
    ) external onlyRole(ADMIN_ROLE) {
        welcomers[_welcomer].isActive = _isActive;
        emit WelcomerStatusUpdated(_welcomer, _isActive);
    }

    function recordAdvanceIssued(address _creator) external onlyRole(ADMIN_ROLE) {
        hasReceivedAdvance[_creator] = true;
    }

    function isEligibleFirstTimer(address _creator) external view returns (bool) {
        return !hasReceivedAdvance[_creator];
    }
}
