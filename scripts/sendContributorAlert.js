const fs = require('fs');

function parseIssueForm(body) {
  const fields = {};
  const pattern = /^### (.+)\r?\n+(.*?)(?=\r?\n### |$)/gms;

  for (const match of String(body || '').matchAll(pattern)) {
    fields[match[1].trim()] = match[2].trim();
  }

  return fields;
}

async function main() {
  const nodemailer = require('nodemailer');
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const issue = event.issue;
  if (!issue) throw new Error('GitHub issue event payload is required');

  const fields = parseIssueForm(issue.body);
  const port = Number(process.env.SMTP_PORT || 587);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const text = [
    'ArtFi contributor request received.',
    '',
    `Issue: #${issue.number}`,
    `GitHub username: ${fields['GitHub username'] || 'not provided'}`,
    `Wallet address: ${fields['Wallet address'] || 'not provided'}`,
    `What they want to help with: ${fields['What you want to help with'] || 'not provided'}`,
    `Relevant links: ${fields['Relevant links / repos / past work'] || 'not provided'}`,
    '',
    `View issue: ${issue.html_url}`,
  ].join('\n');

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: process.env.WHITELIST_REQUEST_TO,
    subject: `ArtFi contributor request: ${issue.title}`,
    text,
  });

  console.log(`Contributor request email sent for issue #${issue.number}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseIssueForm };