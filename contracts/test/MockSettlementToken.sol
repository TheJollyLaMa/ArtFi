// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockSettlementToken is ERC20 {
    constructor() ERC20("Mock Settlement Token", "MSET") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract ForceSend {
    constructor(address payable recipient) payable {
        selfdestruct(recipient);
    }
}

contract FeeOnTransferToken is ERC20 {
    uint256 public constant FEE_BPS = 100;

    constructor() ERC20("Fee On Transfer Token", "FEET") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * FEE_BPS) / 10_000;
        super._update(from, to, value - fee);
        if (fee > 0) super._update(from, address(0xdead), fee);
    }
}
