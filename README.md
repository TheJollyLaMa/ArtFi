# ArtFi

![ArtFi branding](https://github.com/user-attachments/assets/58069599-d5d0-4bf3-a066-a2ac34234ff8)

Zero-to-no-profit micro-liquidity protocol for Artizen creators. 
Automated grant advances, human-in-the-loop onboarding, and smart contract settlement.

## Base deployment

ArtFi now targets **Base** for contract deployments and uses the live `$ART` token contract at:

- `0x44c4516768e47cd97cfF2561B81a74699F23f8Ec`

Deployment configuration defaults:

- Hardhat network: `base`
- RPC env var: `BASE_RPC_URL`
- Token env var: `ART_TOKEN_ADDRESS`

Deploy with:

```bash
npm run deploy:base
```

Need an advance? attend all the quests and classes to show you're accountable and use your boost points and Art tokens for access to loans from last season's successful creators according to your project momentum.
First season newcomers only!

- meant for newcomers to have an easier time with the anticipation phase while coming in hungry from the cold ...
- and to introduce the community to new ways we can extend/receive agency to/from each other across borders with web3 tools, software, and frame of mind.

## Payroll bounty labels

ArtFi payroll automation now recognizes **$ART-only** payout labels on GitHub issues.

- Contributor payout label format: `bounty: <amount> $ART`
- Testing payout label format: `test-bounty: <amount> $ART`

Examples:

- `bounty: 25 $ART`
- `bounty: 100 $ART`
- `test-bounty: 10 $ART`

The bounty workflows only queue payouts when the label matches those exact formats. Queued payroll entries are recorded with `currency: "ART"` in `/home/runner/work/ArtFi/ArtFi/payroll-queue.json`.

### GitHub label setup

Maintainers should create the bounty labels they plan to use in the repository's GitHub label settings using the exact naming convention above. For example, if the repo awards 25, 50, and 100 token bounties, create:

- `bounty: 25 $ART`
- `bounty: 50 $ART`
- `bounty: 100 $ART`
- `test-bounty: 10 $ART`
- `test-bounty: 25 $ART`

Any amount is supported by the automation as long as the label name is exactly `bounty: <amount> $ART` or `test-bounty: <amount> $ART`.
