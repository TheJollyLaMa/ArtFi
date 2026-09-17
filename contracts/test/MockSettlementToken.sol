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
