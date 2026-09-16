const ARTIZEN_LOGO_URL = 'https://raw.githubusercontent.com/TheJollyLaMa/ArtFi/main/Artizen_LOGO.png';
const ENS_ETH_LOGO_URL = 'https://raw.githubusercontent.com/TheJollyLaMa/ArtFi/main/Ens_Eth_Breathe.gif';

const SCENES = [
  ['Creator workshop', '🌌', '🟪', '🧑‍🎨', '🛠️', '✨'],
  ['Sponsor bridge', '🌃', '🟦', '🤝', '🌉', '💸'],
  ['Escrow vault', '🌙', '⬛', '🏦', '🔐', '🪙'],
  ['Advance launch', '🌌', '🟫', '🚀', '📦', '💫'],
  ['Repayment river', '🌧️', '🟦', '🛶', '↩️', '🪙'],
  ['Settlement sunrise', '🌅', '🟧', '⚖️', '✅', '☀️'],
  ['Testing lab', '🌐', '⬜', '🧪', '🔬', '✅'],
  ['Base builders', '🌃', '🟦', '🏗️', '🔵', '🧱'],
  ['Community garden', '☀️', '🟩', '🧑‍🌾', '🌱', '🌻'],
  ['Season payout', '🌤️', '🟨', '🎨', '🏆', '💰'],
  ['Wallet constellation', '🌌', '⬛', '👛', '⭐', '🔗'],
  ['Contract forge', '🌋', '🟥', '🔨', '📜', '🔥'],
  ['Idea spark', '🌠', '🟪', '💡', '🎨', '⚡'],
  ['Global studio', '🌍', '🟩', '🧑‍💻', '🖼️', '🌐'],
  ['Liquidity well', '🌙', '🟦', '⛲', '🪣', '💧'],
  ['Creator camp', '🌌', '🟫', '⛺', '🔥', '🎸'],
  ['Review station', '🌃', '⬜', '👀', '📋', '✅'],
  ['Token train', '🌄', '🟫', '🚂', '🪙', '🛤️'],
  ['Open source city', '🌇', '⬛', '🏙️', '💻', '🤲'],
  ['Milestone mountain', '🌤️', '🟩', '⛰️', '🚩', '🧗'],
  ['Treasury harbor', '🌊', '🟦', '⚓', '🏦', '⛵'],
  ['Onchain gallery', '🌌', '🟪', '🖼️', '🔗', '🎭'],
  ['Bounty orchard', '☀️', '🟩', '🌳', '🎯', '🍎'],
  ['Protocol classroom', '🌤️', '🟨', '🏫', '📚', '🧑‍🏫'],
  ['Future festival', '🎆', '🟪', '🎪', '🎉', '🎶'],
];

function makeArtwork([name, sky, ground, subject, detail, accent]) {
  const rows = [
    [sky, sky, '✨', sky, sky, sky, '⭐', sky, sky, sky],
    [sky, '🟢', sky, sky, accent, sky, sky, sky, '💠', sky],
    [sky, sky, sky, detail, sky, sky, subject, sky, sky, sky],
    [sky, sky, '☁️', sky, sky, sky, sky, '☁️', sky, sky],
    [sky, sky, sky, '🧑‍🎨', subject, detail, '🧑‍💻', sky, sky, sky],
    [sky, sky, '🤝', '➡️', '🪙', '➡️', '🎨', sky, sky, sky],
    [sky, accent, sky, sky, '🔗', sky, sky, accent, sky, sky],
    [ground, ground, ground, ground, ground, ground, ground, ground, ground, ground],
    [ground, '🌱', ground, detail, ground, subject, ground, '🌱', ground, ground],
    [ground, ground, ground, ground, '🟢', '💠', ground, ground, ground, ground],
  ];

  return { name, rows };
}

const ARTWORKS = SCENES.map(makeArtwork);

function artworkIndex(issueNumber, commentType) {
  const input = `${Number(issueNumber) || 0}:${String(commentType || 'comment')}`;
  let hash = 2166136261;
  for (const character of input) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % ARTWORKS.length;
}

function selectArtwork(issueNumber, commentType) {
  return ARTWORKS[artworkIndex(issueNumber, commentType)];
}

function renderArtFiComment(body, issueNumber, commentType) {
  const artwork = selectArtwork(issueNumber, commentType);
  const grid = artwork.rows.map(row => row.join(' ')).join('\n');

  return [
    body,
    '',
    `<p align="center"><img src="${ARTIZEN_LOGO_URL}" alt="Artizen logo" width="48">&nbsp;&nbsp;<img src="${ENS_ETH_LOGO_URL}" alt="ENS and Ethereum logo" width="48"></p>`,
    '',
    `<details><summary>${artwork.name}</summary>`,
    '',
    '```text',
    grid,
    '```',
    '</details>',
  ].join('\n');
}

module.exports = {
  ARTIZEN_LOGO_URL,
  ENS_ETH_LOGO_URL,
  ARTWORKS,
  artworkIndex,
  renderArtFiComment,
  selectArtwork,
};