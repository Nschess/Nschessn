# Nschess Android Trusted Web Activity

This Android project is a Trusted Web Activity (TWA) wrapper for the production PWA at `https://nschessn.vercel.app`.

- Package / application ID: `com.nschess.game`
- Minimum SDK: 23 (Android 6.0)
- Target and compile SDK: 36
- Release output: `app/build/outputs/bundle/release/app-release.aab`

The wrapper intentionally contains no Supabase configuration or application secrets. Authentication and API calls remain in the deployed web application.

## Required local tools

Install JDK 17, Android SDK Platform 36, Android SDK Build-Tools 36.0.0, and a compatible Android Studio/SDK setup. The checked-in Gradle wrapper downloads Gradle 9.4.1 on its first run.

## Create and protect the upload key

Use an upload key only for signing uploads to Google Play; enroll in Play App Signing so Google manages the separate app-signing key used for distributed installs. Do not commit the key, its passwords, or `keystore.properties`.

From the repository root, create the upload key in the ignored Android directory:

```powershell
keytool -genkeypair -v -keystore android\nschess-upload.jks -alias nschess-upload -keyalg RSA -keysize 4096 -validity 10000
Copy-Item android\keystore.properties.example android\keystore.properties
```

Back up that keystore and both passwords in the team's password manager. Losing the upload key requires an upload-key reset; it is not a source-controlled project file.

Edit `android/keystore.properties` and replace its placeholder values. `storeFile` is relative to `android/`.

## Build the signed App Bundle

```powershell
cd android
.\gradlew.bat bundleRelease
```

The release task deliberately stops if the local upload-key configuration is missing. Its signed bundle is written to `android/app/build/outputs/bundle/release/app-release.aab`.

## Digital Asset Links

The Android application already declares the website-side relationship in `app/src/main/res/values/strings.xml`. The website must declare the reverse relationship before release.

1. Obtain the upload certificate SHA-256 fingerprint:

   ```powershell
   keytool -list -v -keystore android\nschess-upload.jks -alias nschess-upload
   ```

2. Replace `UPLOAD_KEY_SHA256_FINGERPRINT` in `../.well-known/assetlinks.json.template` with that fingerprint.
3. When Play App Signing is enrolled, obtain the Play **app-signing** certificate SHA-256 fingerprint and replace `PLAY_APP_SIGNING_SHA256_FINGERPRINT` too. Keep both entries: the upload key supports locally installed release builds, while the Play app-signing key supports the Play-distributed app.
4. Rename/copy the completed file to the website root as `.well-known/assetlinks.json`, deploy it with the web app, and confirm this exact public URL returns JSON over HTTPS:

   `https://nschessn.vercel.app/.well-known/assetlinks.json`

Do not leave either placeholder in the deployed `assetlinks.json`. If validation fails, the wrapper safely falls back to a Custom Tab with browser UI instead of a fullscreen TWA.

No Google Play Console settings are created or changed by this repository.