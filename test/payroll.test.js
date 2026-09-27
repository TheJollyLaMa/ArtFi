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
const { parseTransactionHashes } = require('../scripts/settlePayroll');

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

test('settles every pending entry for multiple creators without touching others', () => {
  const first = { issueRef: 'TheJollyLaMa/ArtFi#1', contributorGithub: 'alice', amount: '10' };
  const second = { issueRef: 'TheJollyLaMa/ArtFi#2', contributorGithub: 'alice', amount: '5' };
  const third = { issueRef: 'TheJollyLaMa/ArtFi#3', contributorGithub: 'bob', amount: '7' };
  const untouched = { issueRef: 'TheJollyLaMa/ArtFi#4', contributorGithub: 'carol', amount: '9' };
  const queue = { pending: [first, second, third, untouched], settled: [] };
  const accounts = { contributors: [
    { github: 'alice', artPending: 15, artEarned: 0 },
    { github: 'bob', artPending: 7, artEarned: 0 },
    { github: 'carol', artPending: 9, artEarned: 0 },
  ] };

  const settled = settleEntries({
    queue,
    accounts,
    contributorGithub: 'alice, bob',
    settledAt: '2026-09-16T15:00:00.000Z',
    settledBy: 'TheJollyLaMa',
  });

  assert.equal(settled.length, 3);
  assert.deepEqual(queue.pending, [untouched]);
  assert.equal(accounts.contributors[0].artPending, 0);
  assert.equal(accounts.contributors[0].artEarned, 15);
  assert.equal(accounts.contributors[1].artPending, 0);
  assert.equal(accounts.contributors[1].artEarned, 7);
  assert.equal(accounts.contributors[2].artPending, 9);
});

test('parses per-creator transaction hashes for batch settlement', () => {
  assert.deepEqual(parseTransactionHashes('alice=0xaaa, bob=0xbbb, malformed, alice=0xccc'), {
    alice: '0xccc',
    bob: '0xbbb',
  });
});

test('queues one entry per currency with fund and router routing', () => {
  const router = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
  const result = createBountyEntries(fixture({
    issue: {
      number: 55,
      labels: [
        { name: 'bounty: 300 ART' },
        { name: 'bounty: 1000 BNUT' },
        { name: 'bounty: 0.5 USDC' },
        { name: 'fund: artfi-repo-dev' },
        { name: `router: ${router}` },
      ],
      assignees: [{ login: 'TheJollyLaMa' }],
    },
  }));

  assert.deepEqual(result.entries.map(entry => [entry.currency, entry.amount, entry.fund, entry.router]), [
    ['ART', '300', 'artfi-repo-dev', router],
    ['BNUT', '1000', 'artfi-repo-dev', router],
    ['USDC', '0.5', 'artfi-repo-dev', router],
  ]);
});

test('does not treat payouts in different currencies on one issue as duplicates', () => {
  const art = createBountyEntries(fixture({
    issue: { number: 55, labels: [{ name: 'bounty: 300 ART' }], assignees: [{ login: 'TheJollyLaMa' }] },
  })).entries;
  const result = createBountyEntries(fixture({
    issue: {
      number: 55,
      labels: [{ name: 'bounty: 300 ART' }, { name: 'bounty: 1000 BNUT' }],
      assignees: [{ login: 'TheJollyLaMa' }],
    },
    queue: { pending: art, settled: [] },
  }));

  assert.deepEqual(result.entries.map(entry => entry.currency), ['BNUT']);
  assert.equal(result.skippedDuplicates, 1);
});

test('rejects ambiguous routing and repeated currency labels', () => {
  const base = { number: 56, assignees: [{ login: 'TheJollyLaMa' }] };
  assert.throws(
    () => createBountyEntries(fixture({ issue: { ...base, labels: [{ name: 'bounty: 5 ART' }, { name: 'bounty: 6 ART' }] } })),
    /more than one ART bounty/
  );
  assert.throws(
    () => createBountyEntries(fixture({ issue: { ...base, labels: [{ name: 'bounty: 5 ART' }, { name: 'fund: a' }, { name: 'fund: b' }] } })),
    /more than one fund/
  );
});

test('ignores unsupported currency bounty labels', () => {
  const result = createBountyEntries(fixture({
    issue: { number: 57, labels: [{ name: 'bounty: 5 DOGE' }], assignees: [{ login: 'TheJollyLaMa' }] },
  }));
  assert.equal(result.reason, 'missing-bounty-label');
});

test('tracks pending and earned balances per currency', () => {
  const accounts = { contributors: [{ ...owner, artPending: 0, bnutPending: 0 }] };
  const entries = [
    { issueRef: 'TheJollyLaMa/ArtFi#55', contributorGithub: owner.github, amount: '1000', currency: 'BNUT' },
    { issueRef: 'TheJollyLaMa/ArtFi#55', contributorGithub: owner.github, amount: '0.5', currency: 'USDC' },
  ];
  applyAccountAccrual(accounts, entries);
  assert.equal(accounts.contributors[0].bnutPending, 1000);
  assert.equal(accounts.contributors[0].usdcPending, 0.5);
  assert.equal(accounts.contributors[0].artPending, 0);

  const queue = { pending: entries.map(entry => ({ ...entry })), settled: [] };
  settleEntries({ queue, accounts, issueRef: 'TheJollyLaMa/ArtFi#55', settledAt: 'now', settledBy: 'TheJollyLaMa' });
  assert.equal(accounts.contributors[0].bnutPending, 0);
  assert.equal(accounts.contributors[0].bnutEarned, 1000);
  assert.equal(accounts.contributors[0].usdcEarned, 0.5);
});