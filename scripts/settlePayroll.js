const fs = require('fs');
const path = require('path');

const { renderArtFiComment } = require('./commentArt');
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

function parseTransactionHashes(value) {
  return String(value || '').split(',').reduce((hashes, pair) => {
    const separator = pair.indexOf('=');
    if (separator < 1) return hashes;
    const contributor = pair.slice(0, separator).trim().toLowerCase();
    const txHash = pair.slice(separator + 1).trim();
    if (contributor && txHash) hashes[contributor] = txHash;
    return hashes;
  }, {});
}

function buildSettlementComment({ settledCount, actor, txHash, issueNumber }) {
  const body = [
    `✅ Settled ${settledCount} payroll entr${settledCount === 1 ? 'y' : 'ies'} by @${actor}.`,
    txHash ? `🔗 Tx: ${txHash}` : '',
  ].filter(Boolean).join('\n');
  return renderArtFiComment(body, issueNumber, 'settlement');
}

async function main() {
  const { owner, repo } = repositoryCoordinates();
  const contributorGithub = String(
    process.env.INPUT_CONTRIBUTORS_GITHUB || process.env.INPUT_CONTRIBUTOR_GITHUB || ''
  ).trim();
  const issueRef = String(process.env.INPUT_ISSUE_REF || '').trim();
  const txHash = String(process.env.INPUT_TX_HASH || '').trim();
  const transactionHashes = parseTransactionHashes(process.env.INPUT_TX_HASHES);
  const queue = readJson(QUEUE_PATH);
  const accounts = readJson(ACCOUNTS_PATH);
  const contributors = contributorGithub.split(',').map(value => value.trim()).filter(Boolean);
  const targets = contributors.length ? contributors : [''];
  const settled = targets.flatMap(contributor => settleEntries({
    queue,
    accounts,
    contributorGithub: contributor,
    issueRef,
    txHash: transactionHashes[contributor.toLowerCase()] || txHash,
    settledAt: new Date().toISOString(),
    settledBy: process.env.GITHUB_ACTOR || 'github-actions[bot]',
  }));

  if (settled.length === 0) {
    console.log('No matching pending entries found.');
    return;
  }

  writeJson(QUEUE_PATH, queue);
  writeJson(ACCOUNTS_PATH, accounts);

  const issueMatch = issueRef.match(/#(\d+)$/);
  if (issueMatch) {
    const issueNumber = Number(issueMatch[1]);
    await postIssueComment(
      owner,
      repo,
      issueNumber,
      buildSettlementComment({
        settledCount: settled.length,
        actor: process.env.GITHUB_ACTOR,
        txHash,
        issueNumber,
      })
    );
  }
  console.log(`Settled ${settled.length} payroll entries.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildSettlementComment, parseTransactionHashes };