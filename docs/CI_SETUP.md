# CI Setup

## Required Secrets

None. npm publishing uses GitHub OIDC trusted publishers (no static token needed).

## npm OIDC Publishing Setup

To enable publishing without an `NPM_TOKEN`:

1. Go to npmjs.com → `@naughtbot/sdk` package settings → Publishing access
2. Add a trusted publisher: GitHub Actions
3. Set repository: `NaughtBot/sdk`, workflow: `release.yml`

## Releasing

```bash
make release VERSION=0.2.0
```

This updates `package.json`, commits, tags, and pushes. CI handles build, test, and npm publish.
