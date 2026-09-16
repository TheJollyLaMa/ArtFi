const fs = require('fs');
const path = require('path');

const { postIssueComment, repositoryCoordinates } = require('./githubApi');
const { settleEntries } = require('./payroll');

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
  const contributorGithub = String(process.env.INPUT_CONTRIBUTOR_GITHUB || '').trim();
  const issueRef = String(process.env.INPUT_ISSUE_REF || '').trim();
  const txHash = String(process.env.INPUT_TX_HASH || '').trim();
  const queue = readJson(QUEUE_PATH);
  const accounts = readJson(ACCOUNTS_PATH);
  const settled = settleEntries({
    queue,
    accounts,
    contributorGithub,
    issueRef,
    txHash,
    settledAt: new Date().toISOString(),
    settledBy: process.env.GITHUB_ACTOR || 'github-actions[bot]',
  });

  if (settled.length === 0) {
    console.log('No matching pending entries found.');
    return;
  }

  writeJson(QUEUE_PATH, queue);
  writeJson(ACCOUNTS_PATH, accounts);

  const issueMatch = issueRef.match(/#(\d+)$/);
  if (issueMatch) {
    await postIssueComment(owner, repo, Number(issueMatch[1]), [
      `✅ Settled ${settled.length} payroll entr${settled.length === 1 ? 'y' : 'ies'} by @${process.env.GITHUB_ACTOR}.`,
      txHash ? `🔗 Tx: ${txHash}` : '',
    ].filter(Boolean).join('\n'));
  }
  console.log(`Settled ${settled.length} payroll entries.`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});