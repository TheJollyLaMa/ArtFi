const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ARTIZEN_LOGO_URL,
  ENS_ETH_LOGO_URL,
  ARTWORKS,
  artworkIndex,
  renderArtFiComment,
  renderArtworkTable,
  selectArtwork,
} = require('../scripts/commentArt');
const { buildMergedPayrollComment } = require('../scripts/processMergedBounty');
const { buildTestingComment } = require('../scripts/processTestingBounty');
const { buildSettlementComment } = require('../scripts/settlePayroll');

test('contains 25 unique 10x10 branded emoji artworks', () => {
  assert.equal(ARTWORKS.length, 25);
  assert.equal(new Set(ARTWORKS.map(artwork => artwork.name)).size, 25);
  assert.equal(new Set(ARTWORKS.map(artwork => JSON.stringify(artwork.rows))).size, 25);

  for (const artwork of ARTWORKS) {
    assert.equal(artwork.rows.length, 10, artwork.name);
    for (const row of artwork.rows) assert.equal(row.length, 10, artwork.name);
    assert.ok(artwork.rows.flat().includes('🟢'), `${artwork.name} lacks the Artizen motif`);
    assert.ok(artwork.rows.flat().includes('💠'), `${artwork.name} lacks the ENS/ETH motif`);
  }
});

test('selects artwork deterministically and rotates across event inputs', () => {
  assert.equal(selectArtwork(30, 'merged-payroll'), selectArtwork(30, 'merged-payroll'));
  const selected = new Set();
  for (let issueNumber = 1; issueNumber <= 100; issueNumber += 1) {
    selected.add(artworkIndex(issueNumber, `event-${issueNumber % 4}`));
  }
  assert.equal(selected.size, 25);
});

test('renders a visible 10x10 grid with both logo assets inside artwork cells', () => {
  const rendered = renderArtFiComment('✅ Queued 25 ART.', 30, 'merged-payroll');
  assert.match(rendered, /✅ Queued 25 ART\./);
  assert.match(rendered, new RegExp(ARTIZEN_LOGO_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(rendered, new RegExp(ENS_ETH_LOGO_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(rendered, /alt="Artizen logo"/);
  assert.match(rendered, /alt="ENS and Ethereum logo"/);
  assert.doesNotMatch(rendered, /<details>|<summary>|```/);

  const table = renderArtworkTable(selectArtwork(30, 'merged-payroll'));
  assert.equal((table.match(/<tr>/g) || []).length, 10);
  assert.equal((table.match(/<td /g) || []).length, 100);
  assert.match(table, /<td align="center"><img[^>]+Artizen logo[^>]*><\/td>/);
  assert.match(table, /<td align="center"><img[^>]+ENS and Ethereum logo[^>]*><\/td>/);
});

test('production builders preserve merged, testing, and settlement messages', () => {
  const comments = [
    buildMergedPayrollComment({
      entries: [{ amount: '20', contributorGithub: 'builder', role: 'implementer' }],
      isManual: false,
      prNumber: 32,
      issueNumber: 30,
    }),
    buildTestingComment('✅ Testing noted.', 30, 'test-complete'),
    buildTestingComment('⚠️ Testing rejected.', 30, 'test-rejected'),
    buildTestingComment('✅ Testing payout queued.', 30, 'test-approved'),
    buildSettlementComment({
      settledCount: 2,
      actor: 'TheJollyLaMa',
      txHash: '0x123',
      issueNumber: 30,
    }),
  ];

  assert.match(comments[0], /Payroll queued from merged PR #32/);
  assert.match(comments[0], /20 ART/);
  assert.match(comments[1], /Testing noted/);
  assert.match(comments[2], /Testing rejected/);
  assert.match(comments[3], /Testing payout queued/);
  assert.match(comments[4], /Settled 2 payroll entries/);
  assert.match(comments[4], /Tx: 0x123/);

  for (const rendered of comments) {
    assert.match(rendered, /Artizen logo/);
    assert.match(rendered, /ENS and Ethereum logo/);
  }
});