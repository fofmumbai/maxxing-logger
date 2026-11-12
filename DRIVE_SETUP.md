# Connecting Google Drive

Mumbai Maxing can save every submitted photo and video to Google Drive, sorted like this:

```
Mumbai Maxing 2026/
  Team 03/
    #12 Kerning crime/
      attempt-1_photo-1.jpg
      attempt-1_video-1.mp4
      attempt-2_photo-1.jpg    ← resubmission after a rejection
```

Choose the option that matches your Google account:

- **Option A: personal Google account** (Gmail, including Google One storage plans). Files go into that account's **My Drive**. ← FoF Mumbai uses this.
- **Option B: Google Workspace with Shared Drives.** Files go into a Shared Drive via a service account.

---

## Option A: personal Google account (Gmail / Google One)

The app signs in as your account, with permission to manage **only the files and folders it creates**.
It cannot see anything else in your Drive.

### A1. Google Cloud project with the Drive API on
In <https://console.cloud.google.com/>, create (or pick) a project, then go to **APIs & Services → Library → Google Drive API → Enable**.

### A2. OAuth consent screen
1. Go to **APIs & Services → OAuth consent screen**. It may be labelled **Google Auth Platform**. Click **Get started**.
2. **App name:** `Mumbai Maxing` · **User support email:** your Gmail, then **Next**.
3. **Audience:** **External**, then **Next**.
4. **Contact information:** your Gmail, then **Next**. Agree to the policy, then **Continue → Create**.
5. Go to **Audience**. Under **Publishing status** click **Publish app → Confirm**, so the status says **In production**.
   **This matters.** In "Testing" mode Google signs the app out every 7 days.
   No Google review is needed, because the app only asks for the limited `drive.file` permission.

### A3. OAuth client
1. Go to **Clients** (or **APIs & Services → Credentials**), then **+ Create client**.
2. **Application type:** **Web application** · **Name:** `Mumbai Maxing server`.
3. Under **Authorized redirect URIs**, click **+ Add URI** and enter exactly:
   ```
   http://localhost:3000/oauth/google/callback
   ```
   After deploying, add a second one for your real address, for example `https://maxing.fofmumbai.com/oauth/google/callback`.
4. Click **Create**. In the popup, click **Download JSON**.
   **This file is secret.** Don't share it or commit it.

### A4. Give the client file to the app
1. Move the downloaded file to `mumbaimaxing/secrets/google-oauth-client.json`.
2. In `.env` (copy it from `.env.example`), set:
   ```
   GOOGLE_OAUTH_CLIENT_FILE=./secrets/google-oauth-client.json
   ```
3. Restart the server. It should print: `Google Drive: ready to connect…`

### A5. Connect
1. Open **http://localhost:3000/admin** (it must be `localhost`, matching the redirect URI) → **Settings → Connect Google Drive**.
2. Sign in with the Google account whose Drive should store the files, then click **Continue / Allow**.
   - If Google shows **"Google hasn't verified this app"**, click **Advanced → Go to Mumbai Maxing (unsafe)**. It's your own app, so this is expected.
3. You're sent back to Settings with **Connected**. A **Mumbai Maxing 2026** folder appears in your My Drive.
   Share that folder with other organisers from Drive if they should browse it.

### On the hosting server
- Add the production redirect URI to the OAuth client (step A3.3).
- Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (from the JSON file), and `PUBLIC_URL=https://your-domain`.
- Open the live admin → Settings → **Connect Google Drive** once.

---

## Option B: Google Workspace Shared Drive (service account)

1. In Cloud Console: **IAM & Admin → Service Accounts → Create** (no roles needed), then **Keys → Add key → JSON**.
   - If you see "key creation is disabled", a super admin must turn off the org policy
     **"Disable service account key creation"** (`iam.disableServiceAccountKeyCreation`) for this project.
2. In Drive: **Shared drives → New**, then **Manage members** → add the service account email as **Content manager**.
   - If that's blocked, an admin needs to change **admin.google.com → Apps → Google Workspace → Drive and Docs → Sharing settings**:
     allow sharing outside the organisation, and tick "Allow people outside your organisation to access files in shared drives".
3. In `.env`, set:
   ```
   GOOGLE_SERVICE_ACCOUNT_FILE=./secrets/google-service-account.json
   DRIVE_FOLDER_ID=<id from the Shared Drive URL>
   ```
   On a host, paste the key JSON as one line into `GOOGLE_SERVICE_ACCOUNT_JSON` instead.

If both options are configured, Option A wins.

---

## How it behaves
- Players upload to the server as before (fast, with progress bars). Within seconds the server copies each file to Drive,
  then deletes its own copy. The dashboard keeps working the same way, loads media from Drive, and has an **Open in Drive** button.
- If Drive is down, disconnected or misconfigured, nothing is lost. Files wait on the server and upload automatically once it's fixed.
  **Settings → Google Drive** shows waiting and failed counts and has **Retry now** / **Reconnect** buttons.
- Renaming a team or task doesn't rename existing Drive folders. Deleting a task doesn't delete its files from Drive.
- `DRIVE_KEEP_LOCAL=1` keeps a server copy as well (more disk, faster dashboard).
