# ArtFi

![ArtFi branding](https://github.com/user-attachments/assets/58069599-d5d0-4bf3-a066-a2ac34234ff8)

Zero-to-no-profit micro-liquidity protocol for Artizen creators. 
Automated grant advances, human-in-the-loop onboarding, and smart contract settlement.

## Base deployment

ArtFi will operate on **Base** ...

$ART - `0x44c4516768e47cd97cfF2561B81a74699F23f8Ec`

... and currently uses the `$ART` token for payroll bot to help us get ArtFi started with a micro-economic spark!

Need an advance? Attend all the quests and classes to show you're accountable and then use your boost points and Art tokens for access to loans from last season's successful creators according to your project momentum.  Once you've shown you're slightly accountable, access to offers will appear from creators who have a little extra to lend some cash in exchange for a similar portion of your seasonal payout to get you by until then.  Read the TERMS!  They are meant to be simple and inviting while still offering a basic guideline for the mercy and generosity of a sponsor. 

First season newcomers only!
- meant for newcomers to have an easier time with the anticipation phase until their first payout while coming in hungry from the cold ...
- introduces the community to new ways we can extend/receive agency to/from each other across borders with web3 tools, software, and frame of mind.

## Payroll bounty labels

ArtFi payroll automation now recognizes **$ART-only** payout labels on GitHub issues.

- Contributor payout label format: `bounty: <amount> ART` (the `$` before `ART` is optional)
- Testing payout label format: `test-bounty: <amount> ART` (the `$` before `ART` is optional)
- Idea originator format: `idea-credit: @username`

Examples:

- `bounty: 25 ART`
- `bounty: 100 $ART`
- `test-bounty: 10 ART`
- `idea-credit: @octocat`

The merge bot runs only when a PR is merged into `main`; closing a PR without merging it never creates a payout automatically. Link the issue with `Closes #123` in the PR body, reference `#123` in the title, or use GitHub's Development sidebar. The bot checks the PR author and issue assignees against `contributor-accounts.json`, then records valid entries with `currency: "ART"` in `payroll-queue.json` for administrator review.

When an exact `idea-credit: @username` label is present, the bounty is split 80% to the whitelisted implementer and 20% to the whitelisted idea originator. A generic `idea-credit` label does not identify a payable originator and therefore does not trigger a split.

## Whitelist requests

People can request whitelist access through the GitHub issue form at **Issues → New issue → Whitelist Request**. The form captures:

- GitHub username
- email for follow-up
- wallet address
- desired role
- contribution summary

When a whitelist request issue is opened, the repo sends an admin email using the configured SMTP secrets. The email includes the request details and a direct link to the issue so the admin can approve the wallet and add them to `contributor-accounts.json`.

To enable email delivery, set these repository secrets:

- `WHITELIST_REQUEST_TO`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

For work intentionally closed without merge, or for an older PR that was not linked correctly, run **Actions → Bounty Bot → Run workflow** with the PR number and optional issue number. Testing bounties use `/test-complete` from an assigned tester followed by `/test-approved` from the repository owner. Finalized payments are moved from pending to settled through **Actions → Settle Payroll**.

