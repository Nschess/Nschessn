# Stability Gate test environment

Nschess live and integration tests are testable only after the disposable
environment has passed the environment gate. This is required for any feature
using Supabase privileged operations, multiple accounts, Realtime,
matchmaking, migrations, or another external service.

## One setup check

Copy `.env.e2e.example` to the ignored `.env.e2e`, then set the dedicated
non-production Supabase URL, public key, generated Account A credentials, and
`E2E_ENVIRONMENT=staging` (or another allowed non-production target).

Keep the server-only key only in the current shell:

```powershell
Copy-Item .env.e2e.example .env.e2e
# Edit .env.e2e with disposable public E2E values and account credentials.
$env:SUPABASE_SECRET_KEY = "<server-only Supabase secret key>"
npm.cmd run test:environment
Remove-Item Env:SUPABASE_SECRET_KEY
```

`npm run test:environment` is the single documented setup check. Locally, if
both Account B fields are blank, it creates the generated disposable Account B
and writes only its credentials to the ignored `.env.e2e`; rerun the check
afterwards if needed. In CI, both account credentials must be supplied as
secrets and no credential file is created.

The check fails before a browser or live test starts when any required value is
missing. It then verifies the generated accounts can authenticate, are
distinct, the Account B fixture can be reset, the profile and Store baseline
are authoritative, the required migration surface is reachable, and the
Supabase Realtime websocket opens. It never accepts a production target or a
personal account for a disposable fixture.

Run the live proof only after the check passes:

```powershell
$env:SUPABASE_SECRET_KEY = "<server-only Supabase secret key>"
npm.cmd run test:matchmaking-live
Remove-Item Env:SUPABASE_SECRET_KEY
```

The live command runs the environment gate first. It cannot fall back to a
mock/static test and it cannot report a blocked live test as a Stability Gate
pass.

## Required configuration

Public/account values may be in the ignored `.env.e2e`; privileged values may
only be process environment variables or CI secrets.

| Name | Purpose |
| --- | --- |
| `E2E_ENVIRONMENT` | Must be `local`, `development`, `test`, or `staging`; production is forbidden. |
| `E2E_BASE_URL` | App URL under test, normally `http://127.0.0.1:4173` locally. |
| `E2E_SUPABASE_URL` | Dedicated non-production Supabase project URL. |
| `E2E_SUPABASE_ANON_KEY` | Public anon/publishable key for the dedicated project. |
| `E2E_EMAIL` / `E2E_PASSWORD` | Generated disposable Account A. |
| `E2E_SECOND_EMAIL` / `E2E_SECOND_PASSWORD` | Generated disposable Account B; local setup can create it when both are blank. |
| `E2E_REALTIME_ENABLED=1` | Explicitly requires the live Realtime path. |
| `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` | Server-only credential for fixture creation/reset; process/CI only. |

The account names must match `nschess-e2e-<8 hex>@proton.me` and
`nschess-e2e-b-<hex>@proton.me`. No production or personal account may be used
for disposable fixtures. Never commit `.env`, `.env.e2e`, credentials, keys,
Playwright storage state, or test artifacts.

## Status meanings

- `PASS` means the named check actually ran and passed.
- `BLOCKED/ENVIRONMENT` means the live check did not run because required
  configuration, credentials, migrations, fixtures, or external service
  readiness is unavailable. It is non-zero and is never a Stability Gate pass.
- `FAIL` means the configured test ran and found a product/regression failure.

## CI secrets

The `Live Stability Gate` job in `.github/workflows/verify.yml` requires these
repository or environment secrets. Missing secrets intentionally fail the job
as `BLOCKED/ENVIRONMENT`:

`NSCHESS_E2E_SUPABASE_URL`, `NSCHESS_E2E_SUPABASE_ANON_KEY`,
`NSCHESS_E2E_EMAIL`, `NSCHESS_E2E_PASSWORD`, `NSCHESS_E2E_SECOND_EMAIL`,
`NSCHESS_E2E_SECOND_PASSWORD`, and `NSCHESS_SUPABASE_SECRET_KEY`.
