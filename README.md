# ART.Fi

Zero-profit micro-liquidity protocol for Artizen creators. Features automated grant advances, human-in-the-loop onboarding, and smart contract settlement.

## Smart Contracts Implemented

- `ANIVTypes.sol`: shared data schemas and loan status enum
- `ANIVRegistry.sol`: creator eligibility and welcomer role registry
- `InitiationVault.sol`: application intake, welcomer approval, disbursement, and season settlement accounting
- `EscrowSettlementRouter.sol`: payout interception and automated debt recovery routing
- `MockERC20.sol`: local test token (USDC-like 6 decimals)

## Local Setup

```bash
npm install
cp .env.example .env
```

## Commands

```bash
npm run compile
npm test
npm run deploy:optimism-sepolia
```

## Notes

The vault calls `recordAdvanceIssued` in `ANIVRegistry`, so deployment/tests grant `ADMIN_ROLE` to the deployed vault after initialization.
