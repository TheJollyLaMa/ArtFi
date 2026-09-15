// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./InitiationVault.sol";

contract EscrowSettlementRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdcToken;
    InitiationVault public vault;
    address public artizenSeasonDisburser;

    modifier onlyArtizen() {
        require(msg.sender == artizenSeasonDisburser, "Only Artizen Disburser can call");
        _;
    }

    constructor(address _usdcToken, address _artizenSeasonDisburser) {
        usdcToken = IERC20(_usdcToken);
        artizenSeasonDisburser = _artizenSeasonDisburser;
    }

    function setVault(address _vault) external {
        require(address(vault) == address(0), "Vault already set");
        vault = InitiationVault(_vault);
    }

    function executeDisbursement(
        address _creator,
        uint256 _grossMatchAmount
    ) external onlyArtizen {
        usdcToken.safeTransferFrom(msg.sender, address(this), _grossMatchAmount);
        usdcToken.forceApprove(address(vault), _grossMatchAmount);

        uint256 netCreatorPayout = vault.settleSeasonPayout(_creator, _grossMatchAmount);

        uint256 recoveredDebt = _grossMatchAmount - netCreatorPayout;
        if (recoveredDebt > 0) {
            usdcToken.safeTransfer(address(vault), recoveredDebt);
        }
        if (netCreatorPayout > 0) {
            usdcToken.safeTransfer(_creator, netCreatorPayout);
        }
    }
}
