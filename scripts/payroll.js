const BOUNTY_LABEL_RE = /^bounty:\s*(\d+(?:\.\d+)?)\s*\$?ART$/i;
const TEST_BOUNTY_LABEL_RE = /^test-bounty:\s*(\d+(?:\.\d+)?)\s*\$?ART$/i;
const IDEA_CREDIT_LABEL_RE = /^idea-credit:\s*@?([-\w]+)$/i;
const CLOSING_ISSUE_RE = /(?:closes?|fixes?|resolves?)\s+(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)/gi;
const TITLE_ISSUE_RE = /#(\d+)/g;

const CONTRIBUTOR_ALIASES = {
  'copilot-swe-agent': 'copilot',
  'copilot-swe-agent[bot]': 'copilot',
};

function normalizeLogin(login) {
  const value = String(login || '').trim();
  return CONTRIBUTOR_ALIASES[value.toLowerCase()] || value;
}

function labelNames(issue) {
  return (issue.labels || []).map(label => typeof label === 'string' ? label : label.name);
}

function parseAmountLabel(issue, pattern = BOUNTY_LABEL_RE) {
  for (const label of labelNames(issue)) {
    const match = String(label || '').match(pattern);
    if (match) return { label, amount: normalizeAmount(match[1]) };
  }
  return null;
}

function parseIdeaCredit(issue) {
  for (const label of labelNames(issue)) {
    const match = String(label || '').match(IDEA_CREDIT_LABEL_RE);
    if (match) return normalizeLogin(match[1]);
  }
  return null;
}

function extractIssueNumbers({ body = '', title = '', linked = [], override = [] } = {}) {
  const numbers = new Set();
  for (const value of override) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  }

  for (const match of String(body).matchAll(CLOSING_ISSUE_RE)) numbers.add(Number(match[1]));
  for (const match of String(title).matchAll(TITLE_ISSUE_RE)) numbers.add(Number(match[1]));
  for (const value of linked) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) numbers.add(number);
  }
  return [...numbers];
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Invalid payout amount: ${value}`);
  return String(Number(amount.toFixed(8)));
}

function splitIdeaCredit(amount) {
  const total = Number(normalizeAmount(amount));
  return {
    implementer: normalizeAmount(total * 0.8),
    originator: normalizeAmount(total * 0.2),
  };
}

function findAccount(accounts, login) {
  const normalized = normalizeLogin(login).toLowerCase();
  return (accounts.contributors || []).find(
    account => String(account.github || '').trim().toLowerCase() === normalized
  );
}

function requireWhitelistedAccount(accounts, candidates, description) {
  for (const login of candidates) {
    const account = findAccount(accounts, login);
    if (account && String(account.walletAddress || '').trim()) return account;
  }
  throw new Error(`No whitelisted wallet found for ${description}: ${candidates.filter(Boolean).join(', ') || 'none'}`);
}

function entryRole(entry) {
  return String(entry.role || 'contributor').toLowerCase();
}

function isDuplicate(queue, candidate) {
  const candidateIssueRef = String(candidate.issueRef || '').trim();
  const candidateGithub = String(candidate.contributorGithub || '').trim().toLowerCase();
  const candidateRole = entryRole(candidate);

  return [...(queue.pending || []), ...(queue.settled || [])].some(entry => {
    if (String(entry.issueRef || '').trim() !== candidateIssueRef) return false;

    const entryGithub = String(entry.contributorGithub || '').trim().toLowerCase();
    const entryRoleName = entryRole(entry);

    if (entryGithub === candidateGithub) return true;
    if (candidateRole === 'contributor') return false;
    return (entryRoleName === 'implementer' || entryRoleName === 'idea-originator') &&
      (candidateRole === 'implementer' || candidateRole === 'idea-originator');
  });
}

function pickWhitelistedTester({ assigneeLogins = [], accounts, commenter = '' } = {}) {
  const eligible = assigneeLogins
    .map(login => normalizeLogin(login))
    .filter(Boolean)
    .map(login => findAccount(accounts, login))
    .filter(account => account && String(account.walletAddress || '').trim());

  if (eligible.length === 0) {
    throw new Error('No assigned tester on this issue has a whitelisted wallet.');
  }

  const commenterKey = normalizeLogin(commenter || '').toLowerCase();
  const commenterMatch = eligible.find(account => String(account.github || '').trim().toLowerCase() === commenterKey);
  if (commenterMatch) return commenterMatch;

  if (eligible.length > 1) {
    throw new Error(`Multiple assigned testers have whitelisted wallets: ${eligible.map(account => account.github).join(', ')}`);
  }

  return eligible[0];
}

function createBountyEntries({ issue, pr, accounts, queue, repoSlug, queuedAt, queuedBy }) {
  const bounty = parseAmountLabel(issue);
  if (!bounty) return { entries: [], reason: 'missing-bounty-label' };

  const prAuthor = normalizeLogin(pr.user && pr.user.login);
  const assignees = (issue.assignees || []).map(assignee => normalizeLogin(assignee.login));
  const candidates = [...new Set([prAuthor, ...assignees].filter(Boolean))];
  const implementer = requireWhitelistedAccount(accounts, candidates, 'PR author or issue assignee');
  const ideaOriginatorLogin = parseIdeaCredit(issue);
  const issueRef = `${repoSlug}#${issue.number}`;
  const common = {
    issueRef,
    currency: 'ART',
    queuedAt,
    queuedBy,
    prNumber: pr.number,
  };

  let entries;
  if (ideaOriginatorLogin) {
    const originator = requireWhitelistedAccount(accounts, [ideaOriginatorLogin], 'idea originator');
    const split = splitIdeaCredit(bounty.amount);
    entries = [
      {
        ...common,
        contributor: implementer.walletAddress,
        contributorGithub: implementer.github,
        amount: split.implementer,
        role: 'implementer',
      },
      {
        ...common,
        contributor: originator.walletAddress,
        contributorGithub: originator.github,
        amount: split.originator,
        role: 'idea-originator',
      },
    ];
  } else {
    entries = [{
      ...common,
      contributor: implementer.walletAddress,
      contributorGithub: implementer.github,
      amount: bounty.amount,
    }];
  }

  const newEntries = entries.filter(entry => !isDuplicate(queue, entry));
  return {
    entries: newEntries,
    skippedDuplicates: entries.length - newEntries.length,
    bountyLabel: bounty.label,
  };
}

function applyAccountAccrual(accounts, entries) {
  for (const entry of entries) {
    const account = findAccount(accounts, entry.contributorGithub);
    if (!account) continue;
    account.artPending = Number(((Number(account.artPending) || 0) + Number(entry.amount)).toFixed(8));
    if (!Array.isArray(account.issuesClosed)) account.issuesClosed = [];
    if (!account.issuesClosed.includes(entry.issueRef)) account.issuesClosed.push(entry.issueRef);
    if (entry.role === 'idea-originator') {
      if (!Array.isArray(account.ideasCredited)) account.ideasCredited = [];
      if (!account.ideasCredited.includes(entry.issueRef)) account.ideasCredited.push(entry.issueRef);
    }
  }
}

function settleEntries({ queue, accounts, contributorGithub = '', issueRef = '', txHash = '', settledAt, settledBy }) {
  const contributorFilter = String(contributorGithub).trim().toLowerCase();
  const issueFilter = String(issueRef).trim();
  const matches = entry =>
    (!contributorFilter || String(entry.contributorGithub || '').trim().toLowerCase() === contributorFilter) &&
    (!issueFilter || String(entry.issueRef || '').trim() === issueFilter);
  const selected = (queue.pending || []).filter(matches);
  queue.pending = (queue.pending || []).filter(entry => !matches(entry));

  const settled = selected.map(entry => ({
    ...entry,
    settledAt,
    settledBy,
    ...(txHash ? { txHash } : {}),
  }));
  if (!Array.isArray(queue.settled)) queue.settled = [];
  queue.settled.push(...settled);

  for (const entry of settled) {
    const account = findAccount(accounts, entry.contributorGithub);
    if (!account) continue;
    account.artPending = Number(Math.max(0, (Number(account.artPending) || 0) - Number(entry.amount)).toFixed(8));
    account.artEarned = Number(((Number(account.artEarned) || 0) + Number(entry.amount)).toFixed(8));
  }
  return settled;
}

module.exports = {
  BOUNTY_LABEL_RE,
  TEST_BOUNTY_LABEL_RE,
  createBountyEntries,
  extractIssueNumbers,
  findAccount,
  isDuplicate,
  normalizeAmount,
  normalizeLogin,
  parseAmountLabel,
  parseIdeaCredit,
  pickWhitelistedTester,
  splitIdeaCredit,
  applyAccountAccrual,
  settleEntries,
};