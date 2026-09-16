const fs = require('fs');
const path = require('path');

const { githubRequest, postIssueComment, repositoryCoordinates } = require('./githubApi');
const {
  TEST_BOUNTY_LABEL_RE,
  applyAccountAccrual,
  isDuplicate,
  normalizeLogin,
  parseAmountLabel,
  pickWhitelistedTester,
} = require('./payroll');

const ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.join(ROOT, 'payroll-queue.json');
const ACCOUNTS_PATH = path.join(ROOT, 'contributor-accounts.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { owner, repo } = repositoryCoordinates();
  const event = readJson(process.env.GITHUB_EVENT_PATH);
  const comment = String(event.comment && event.comment.body || '').trim();
  const commenter = normalizeLogin(event.comment && event.comment.user && event.comment.user.login);
  const issueNumber = Number(event.issue && event.issue.number);
  const issue = await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`);
  const bounty = parseAmountLabel(issue, TEST_BOUNTY_LABEL_RE);

  if (!bounty) {
    console.log(`Issue #${issueNumber} has no label matching "test-bounty: <amount> ART".`);
    return;
  }

  const assigneeLogins = (issue.assignees || []).map(assignee => normalizeLogin(assignee.login));
  if (comment.startsWith('/test-complete')) {
    if (!assigneeLogins.some(login => login.toLowerCase() === commenter.toLowerCase())) {
      await postIssueComment(owner, repo, issueNumber, '⚠️ Only assigned testers can use `/test-complete`.');
      return;
    }
    await postIssueComment(
      owner,
      repo,
      issueNumber,
      `✅ Thanks @${commenter} — your testing work has been noted. Awaiting \`/test-approved\` from the maintainer.`
    );
    return;
  }

  if (!comment.startsWith('/test-approved')) return;
  if (commenter.toLowerCase() !== owner.toLowerCase()) {
    await postIssueComment(owner, repo, issueNumber, '⚠️ Only the repository owner can approve testing payouts.');
    return;
  }

  const queue = readJson(QUEUE_PATH);
  const accounts = readJson(ACCOUNTS_PATH);
  if (!Array.isArray(queue.pending)) queue.pending = [];
  if (!Array.isArray(queue.settled)) queue.settled = [];
  if (!Array.isArray(accounts.contributors)) accounts.contributors = [];

  const tester = pickWhitelistedTester({ assigneeLogins, accounts, commenter });

  const entry = {
    issueRef: `${owner}/${repo}#${issueNumber}`,
    contributor: tester.walletAddress,
    contributorGithub: tester.github,
    amount: bounty.amount,
    currency: 'ART',
    role: 'tester',
    queuedAt: new Date().toISOString(),
    queuedBy: process.env.GITHUB_ACTOR || commenter,
  };
  if (isDuplicate(queue, entry)) {
    console.log(`Testing payout already exists for ${entry.issueRef} / @${entry.contributorGithub}.`);
    return;
  }

  queue.pending.push(entry);
  applyAccountAccrual(accounts, [entry]);
  writeJson(QUEUE_PATH, queue);
  writeJson(ACCOUNTS_PATH, accounts);
  await postIssueComment(
    owner,
    repo,
    issueNumber,
    `✅ Queued ${entry.amount} ART testing bounty for @${entry.contributorGithub}, pending administrator settlement.`
  );
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});