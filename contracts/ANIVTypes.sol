// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library ANIVTypes {
    enum LoanStatus {
        None,
        Applied,
        Approved,
        Active,
        Settled,
        Defaulted,
        Flagged
    }

    struct CreatorApplication {
        uint256 applicationId;
        address creatorAddress;
        uint256 requestedAmount;
        string category;
        string ipfsExpenseDetailsHash;
        uint256 timestamp;
        LoanStatus status;
    }

    struct Loan {
        uint256 loanId;
        address creator;
        address assignedWelcomer;
        uint256 principalUSDC;
        uint256 timestampDisbursed;
        bool isSettled;
        bool isDefaulted;
    }

    struct WelcomerProfile {
        address welcomerAddress;
        string handle;
        bool isActive;
        uint256 totalCasesHandled;
        uint256 successfulSettlements;
    }
}
