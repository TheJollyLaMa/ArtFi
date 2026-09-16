# ArtFi Pages

The public ArtFi site deploys automatically from `main` through [Deploy ArtFi Pages](../.github/workflows/deploy-pages.yml).

The deployment publishes only:

- `index.html`
- public branding images
- `payroll-queue.json`
- the browser-side UCAN client

Contracts, tests, npm files, `.env` values, the Pinata JWT, SMTP credentials, and the browser-auth server are never copied into the Pages artifact.

## Browser authorization

GitHub Pages serves static files only. The **Authorize browser** control therefore needs `meta[name="artfi-auth-endpoint"]` in `index.html` pointed at the separately hosted ArtFi browser-auth service. That service must allow the exact Pages origin in `ARTFI_ALLOWED_ORIGINS` and must serve HTTPS.

The relative default `/api/browser-auth/start` is useful when a reverse proxy serves the static site and auth service together. For ordinary `*.github.io` hosting, replace it with the deployed auth service URL before the first production authorization test.

## First deployment

1. Enable **Settings → Pages → GitHub Actions** as the source, if Pages is not enabled yet.
2. Merge changes to `main` or run **Actions → Deploy ArtFi Pages → Run workflow**.
3. Confirm the generated Pages URL and use that exact origin in `ARTFI_ALLOWED_ORIGINS` on the auth service.
4. Configure the auth service's `ARTFI_AUTH_PUBLIC_URL` and Pinata/SMTP secrets separately.

## IPFS metadata reminder

The Pages deployment does not upload user metadata to IPFS. Before the first live advance, create and upload these JSON documents through Pinata or IPFS Desktop:

- `profile.json`
- `request.json`
- `offer.json`
- `outcome.json`

Use the resulting `ipfs://CID` values in the corresponding wallet transactions. Do not commit those JSON files, email addresses, private salts, UCAN keys, Pinata credentials, or sensitive plaintext to this repository. See [IPFS_UCAN.md](IPFS_UCAN.md) for the upload and encryption flow.