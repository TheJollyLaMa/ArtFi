const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BOUNTY_LABEL_RE,
  TEST_BOUNTY_LABEL_RE,
  applyAccountAccrual,
  createBountyEntries,
  extractIssueNumbers,
  parseAmountLabel,
  pickWhitelistedTester,
  settleEntries,
} = require('../scripts/payroll');

const owner = {
  github: 'TheJollyLaMa',
  walletAddress: '0x807061DF657A7697c04045dA7d16D941861cAABc',
};

function fixture(overrides = {}) {
  return {
    issue: {
      number: 14,
      labels: [{ name: 'bounty: 100 ART' }],
      assignees: [{ login: 'TheJollyLaMa' }],
      ...overrides.issue,
    },
    pr: {
      number: 15,
      user: { login: 'copilot-swe-agent[bot]' },
      ...overrides.pr,
    },
    accounts: { contributors: [{ ...owner }], ...overrides.accounts },
    queue: { pending: [], settled: [], ...overrides.queue },
    repoSlug: 'TheJollyLaMa/ArtFi',
    queuedAt: '2026-09-16T00:00:00.000Z',
    queuedBy: 'github-actions[bot]',
  };
}

test('accepts live ART labels with or without a dollar sign', () => {
  assert.equal(parseAmountLabel({ labels: [{ name: 'bounty: 100 ART' }] }).amount, '100');
  assert.equal(parseAmountLabel({ labels: [{ name: 'bounty: 2.5 $ART' }] }).amount, '2.5');
  assert.equal(parseAmountLabel({ labels: [{ name: 'test-bounty: 10 ART' }] }, TEST_BOUNTY_LABEL_RE).amount, '10');
  assert.match('bounty: 1 ART', BOUNTY_LABEL_RE);
});

test('combines PR body, title, linked, and manual issue references', () => {
  assert.deepEqual(extractIssueNumbers({
    body: 'Closes #14 and resolves TheJollyLaMa/ArtFi#18',
    title: 'Finish #14 and #22',
    linked: [18, 30],
    override: ['31'],
  }), [31, 14, 18, 22, 30]);
});

test('falls back from an unwhitelisted bot PR author to a whitelisted assignee', () => {
  const result = createBountyEntries(fixture());
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0], {
    issueRef: 'TheJollyLaMa/ArtFi#14',
    currency: 'ART',
    queuedAt: '2026-09-16T00:00:00.000Z',
    queuedBy: 'github-actions[bot]',
    prNumber: 15,
    contributor: owner.walletAddress,
    contributorGithub: owner.github,
    amount: '100',
  });
});

test('splits a precise idea-credit label into role-separated 80/20 entries', () => {
  const result = createBountyEntries(fixture({
    issue: {
      number: 14,
      labels: [
        { name: 'bounty: 100 ART' },
        { name: 'idea-credit: @TheJollyLaMa' },
      ],
      assignees: [{ login: 'TheJollyLaMa' }],
    },
  }));

  assert.deepEqual(result.entries.map(entry => [entry.role, entry.amount]), [
    ['implementer', '80'],
    ['idea-originator', '20'],
  ]);
});

test('does not treat the generic idea-credit label as a payable originator', () => {
  const result = createBountyEntries(fixture({
    issue: {
      number: 18,
      labels: [{ name: 'bounty: 100 ART' }, { name: 'idea-credit' }],
      assignees: [{ login: 'TheJollyLaMa' }],
    },
  }));
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].amount, '100');
  assert.equal(result.entries[0].role, undefined);
});

test('deduplicates across pending and settled queues with role awareness', () => {
  const previous = createBountyEntries(fixture({
    issue: {
      number: 14,
      labels: [
        { name: 'bounty: 100 ART' },
        { name: 'idea-credit: @TheJollyLaMa' },
      ],
      assignees: [{ login: 'TheJollyLaMa' }],
    },
  })).entries;
  const result = createBountyEntries(fixture({
    issue: {
      number: 14,
      labels: [
        { name: 'bounty: 100 ART' },
        { name: 'idea-credit: @TheJollyLaMa' },
      ],
      assignees: [{ login: 'TheJollyLaMa' }],
    },
    queue: { pending: [previous[0]], settled: [previous[1]] },
  }));

  assert.equal(result.entries.length, 0);
  assert.equal(result.skippedDuplicates, 2);
});

test('treats a contributor payout and an idea-credit payout on the same issue as the same participant payment', () => {
  const queue = {
    pending: [{
      issueRef: 'TheJollyLaMa/ArtFi#14',
      contributorGithub: owner.github,
      contributor: owner.walletAddress,
      amount: '100',
      currency: 'ART',
      role: 'contributor',
      queuedAt: '2026-09-16T00:00:00.000Z',
      queuedBy: 'github-actions[bot]',
    }],
    settled: [],
  };

  const result = createBountyEntries(fixture({
    issue: {
      number: 14,
      labels: [
        { name: 'bounty: 100 ART' },
        { name: 'idea-credit: @TheJollyLaMa' },
      ],
      assignees: [{ login: 'TheJollyLaMa' }],
    },
    accounts: { contributors: [{ ...owner }] },
    queue,
  }));

  assert.equal(result.entries.length, 0);
  assert.equal(result.skippedDuplicates, 2);
});

test('selects the commenting assigned tester when multiple testers have wallets', () => {
  const accounts = { contributors: [
    { github: 'alice', walletAddress: '0x1111111111111111111111111111111111111111' },
    { github: 'bob', walletAddress: '0x2222222222222222222222222222222222222222' },
  ] };

  const tester = pickWhitelistedTester({
    assigneeLogins: ['alice', 'bob'],
    accounts,
    commenter: 'bob',
  });

  assert.equal(tester.github, 'bob');
});

test('rejects ambiguous tester payouts when more than one assigned tester has a whitelisted wallet', () => {
  const accounts = { contributors: [
    { github: 'alice', walletAddress: '0x1111111111111111111111111111111111111111' },
    { github: 'bob', walletAddress: '0x2222222222222222222222222222222222222222' },
  ] };

  assert.throws(
    () => pickWhitelistedTester({
      assigneeLogins: ['alice', 'bob'],
      accounts,
      commenter: 'carol',
    }),
    /Multiple assigned testers/
  );
});

test('rejects a payout when no candidate has a whitelisted wallet', () => {
  assert.throws(
    () => createBountyEntries(fixture({ accounts: { contributors: [] } })),
    /No whitelisted wallet found/
  );
});

test('accrues ART totals and idea-originator history', () => {
  const accounts = { contributors: [{ ...owner, artPending: 5, issuesClosed: [] }] };
  applyAccountAccrual(accounts, [{
    issueRef: 'TheJollyLaMa/ArtFi#14',
    contributorGithub: owner.github,
    amount: '20',
    role: 'idea-originator',
  }]);

  assert.equal(accounts.contributors[0].artPending, 25);
  assert.deepEqual(accounts.contributors[0].issuesClosed, ['TheJollyLaMa/ArtFi#14']);
  assert.deepEqual(accounts.contributors[0].ideasCredited, ['TheJollyLaMa/ArtFi#14']);
});

test('an issue-only settlement does not settle unrelated pending entries', () => {
  const accounts = { contributors: [{ ...owner, artPending: 150, artEarned: 0 }] };
  const target = {
    issueRef: 'TheJollyLaMa/ArtFi#14',
    contributorGithub: owner.github,
    contributor: owner.walletAddress,
    amount: '100',
    currency: 'ART',
  };
  const other = { ...target, issueRef: 'TheJollyLaMa/ArtFi#99', amount: '50' };
  const queue = { pending: [target, other], settled: [] };

  const settled = settleEntries({
    queue,
    accounts,
    issueRef: target.issueRef,
    settledAt: '2026-09-16T01:00:00.000Z',
    settledBy: 'TheJollyLaMa',
  });

  assert.equal(settled.length, 1);
  assert.equal(queue.pending.length, 1);
  assert.equal(queue.pending[0].issueRef, other.issueRef);
  assert.equal(accounts.contributors[0].artPending, 50);
  assert.equal(accounts.contributors[0].artEarned, 100);
});