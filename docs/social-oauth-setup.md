# Nschess Google and Facebook OAuth setup

Nschess uses the existing Supabase Auth client and returns every social flow to a reviewed Nschess origin. Provider secrets belong only in the Supabase dashboard; do not add them to Vercel client variables, `.env.e2e`, source code, or browser logs.

## Values for this project

| Purpose | Value |
| --- | --- |
| Production site URL | `https://nschessn.vercel.app` |
| Supabase project callback (Google and Facebook) | `https://jfrvoykwowzthlvzwsmi.supabase.co/auth/v1/callback` |
| Local E2E return URL | `http://127.0.0.1:4173/?auth=oauth` |

The provider callback is always Supabase's `/auth/v1/callback`, not a route in this repository. `redirectTo` is the final Nschess return URL and must be allowlisted in Supabase.

## 1. Configure Supabase URL protection

In **Supabase Dashboard → Authentication → URL Configuration**:

1. Set **Site URL** to `https://nschessn.vercel.app`.
2. Add `https://nschessn.vercel.app/**` to **Redirect URLs**.
3. For local interactive OAuth testing, add `http://127.0.0.1:4173/**`. Do not add broad public wildcards.
4. Add any intentionally reviewed staging or Vercel preview URL explicitly; do not use an unrestricted `*.vercel.app` pattern.

On the Nschess deployment, set the public-origin configuration (these are origins, not secrets):

```text
AUTH_SITE_URL=https://nschessn.vercel.app
# Optional, comma-separated, explicitly reviewed extra origins only:
AUTH_REDIRECT_ORIGINS=https://reviewed-preview.example.com
```

`/api/auth-config` exposes only the resulting trusted origin list together with the already-public Supabase URL/key. The browser refuses to start OAuth from any origin absent from that list.

## 2. Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select/create the project that will own Nschess OAuth.
2. Configure the OAuth consent screen (application name, support email, approved domains, privacy policy, and production publishing as required by Google).
3. Under **APIs & Services → Credentials**, create an **OAuth client ID** of type **Web application**.
4. Add `https://nschessn.vercel.app` under **Authorized JavaScript origins**. Add an explicitly reviewed staging origin only when used. The local browser origin is optional here because the browser redirects through Supabase, but may be added for local provider diagnostics.
5. Add this exact **Authorized redirect URI**:

   ```text
   https://jfrvoykwowzthlvzwsmi.supabase.co/auth/v1/callback
   ```

6. In **Supabase Dashboard → Authentication → Sign In / Providers → Google**, enable Google and paste the Google client ID and client secret. Save.
7. Test with a non-production OAuth account. The Nschess button will call `signInWithOAuth({ provider: "google", options: { redirectTo } })`; it cannot complete until this dashboard configuration is saved.

## 3. Facebook

1. Create/select an app in [Meta for Developers](https://developers.facebook.com/), then add the **Facebook Login** product.
2. In **Facebook Login → Settings**, add this exact **Valid OAuth Redirect URI**:

   ```text
   https://jfrvoykwowzthlvzwsmi.supabase.co/auth/v1/callback
   ```

3. Configure the app domain/privacy policy/contact requirements required by Meta and request/enable the `email` permission. Nschess must not rely on an email being returned; the profile trigger has a safe username fallback.
4. Copy the Facebook App ID and App Secret only into **Supabase Dashboard → Authentication → Sign In / Providers → Facebook**, then enable the provider and save.
5. While the Meta app is in **Development** mode, only app roles/test users can sign in. Move to **Live** only after completing Meta's required app-review/business/privacy steps for public users.

## Profile, account linking, and privacy behavior

- The existing `auth.users → public.profiles` trigger remains the only profile-creation mechanism. It produces a profile keyed to the authenticated user ID and ignores external avatar URLs.
- The trigger now safely derives a product username from provider metadata (`username`, `preferred_username`, `user_name`, `full_name`, then `name`) and uses a deterministic `player_<id>` fallback. It never exposes provider email to public identity UI.
- Supabase Auth owns identity linking. Nschess does **not** merge users in browser JavaScript based on an email address. If Supabase associates an OAuth identity with an existing user, the same `auth.users.id` reaches the existing profile. If it intentionally creates a different user ID, it gets a separate profile rather than risking an unsafe merge.
- Explicit account linking via Supabase `linkIdentity` is not added by this change. It should be a separately designed, re-authenticated account-settings feature with a test plan.
- Coins, Store inventory/equipped cosmetics, Name Styles, refresh persistence, and logout all continue to resolve from the existing authenticated profile/server Store lifecycle.

## Verification checklist

1. Confirm Google and Facebook buttons show a pending state immediately and cannot be double-clicked.
2. Confirm the generated `redirectTo` is exactly one of the configured Nschess origins, ending in `/?auth=oauth`.
3. Complete one manual Google and one manual Facebook sign-in using non-production test identities.
4. Confirm the authenticated account has a `public.profiles` row, a safe visible username, functional Store balance/inventory, and a stable Name Style after refresh/logout/login.
5. Verify a provider cancellation or configuration error returns a clear in-product error without exposing provider secrets.
