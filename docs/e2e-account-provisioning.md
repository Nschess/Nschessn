# Permanent disposable Account B

SQL alone is not a supported way to create a Supabase Auth user. The project
has an `auth.users` trigger that creates `public.profiles`, but it does not
expose a SQL Auth-admin function. Do not insert directly into `auth.users` or
`auth.identities`; those are GoTrue-owned tables and incomplete rows can make
password login fail.

Use the one-time local provisioning script instead. It calls Supabase's
supported Auth Admin REST API, verifies password login through the public
Auth endpoint, verifies the profile trigger, gives the disposable account
distinctive profile data, equips `name-violet`, and writes only the Account B
email/password/style values to the ignored `.env.e2e` file. It never prints the
password and never stores a service-role key.

The setup resets both generated disposable E2E wallets to exactly
`1,000,000,000` coins and verifies that balance through the authenticated
`get_store_state()` RPC. It only touches the exact generated primary
(`nschess-e2e-<8 hex>@proton.me`) and secondary
(`nschess-e2e-b-<hex>@proton.me`) accounts; it does not modify inventory,
ownership, equipped cosmetics, or any other account.
An existing secondary Auth record must also carry the provisioner's
`e2e=true`/`e2e_role=account_b` marker; a matching but unmarked address is
rejected rather than modified.

The preferred modern `SUPABASE_SECRET_KEY` is required only in the current
shell. `SUPABASE_SERVICE_ROLE_KEY` remains a legacy fallback. Neither key is
read from `.env.e2e`, written to disk, bundled, or logged. Supabase's current
secret API keys are sent as an `apikey` server header, not as a browser or
Bearer credential.

```powershell
$env:SUPABASE_SECRET_KEY = "<use the local server-only secret key temporarily>"
npm.cmd run provision:e2e-b
Remove-Item Env:SUPABASE_SECRET_KEY
```

For repeated test runs, use the wallet-only reset without changing either
account's profile or Store inventory:

```powershell
npm.cmd run test:e2e-wallet
```

When `SUPABASE_SECRET_KEY` (or the legacy `SUPABASE_SERVICE_ROLE_KEY`) is present, `test:store-preflight` performs
the same wallet-only reset automatically if the authoritative primary balance
falls below the full catalog budget. The key is never read from `.env.e2e`,
written to disk, or printed. Without that server-only key, preflight remains
read-only and fails clearly rather than using a local wallet fallback.

The script generates a new `nschess-e2e-b-<hex>@proton.me` identity when
`E2E_SECOND_EMAIL`/`E2E_SECOND_PASSWORD` are empty. On later runs it reuses
that exact generated email, safely resets only its password, and refreshes its
test profile/cosmetic state. It refuses to touch an email that is not in the
generated Account B format and refuses ambiguous Auth matches.

After successful provisioning, run:

```powershell
npm.cmd run test:store-preflight
npm.cmd run test:full
```

The Account B proof then runs automatically. The primary disposable account
must also remain above the existing Store preflight budget for full runs; the
automatic reset keeps both generated E2E wallets above that budget.
