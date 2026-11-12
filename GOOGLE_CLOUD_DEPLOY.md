# Deploying Mumbai Maxing on Google Cloud (free trial)

The result is a small always‑on server in Google's **Mumbai** region, at `https://maxing.fofmumbai.com`, with automatic HTTPS.
It costs about **$15/month**, which comes out of the **$300 free trial credit**, so it's effectively free.

You need: the `mumbai-maxing` Cloud project (already created), a card for the trial sign‑up, and access to fofmumbai.com's DNS on **Netlify**.

---

## 1. Activate the free trial
1. In the Cloud console, click **Start free** on the "$300 in credit" banner (or go to **Billing**).
2. Complete sign‑up (country: India, card details). Google doesn't charge automatically when the trial ends.
3. Go to **Billing → My projects** and make sure **Mumbai Maxing** is linked to the new trial billing account.
   If it says "Billing is disabled", use **⋮ → Change billing** and pick the trial account.

## 2. Create the server (VM)
Open **https://console.cloud.google.com/compute/instancesAdd?project=mumbai-maxing**
(If asked to enable the Compute Engine API, click **Enable** and wait about a minute.)

| Setting | Value |
|---|---|
| Name | `mumbai-maxing` |
| Region / Zone | **asia-south1 (Mumbai)** / `asia-south1-a` |
| Machine | **E2 → e2-small** (2 vCPU shared, 2 GB) |
| OS and storage → Change | **Ubuntu 24.04 LTS (x86/64)**, **Balanced persistent disk**, **30 GB** |
| Networking → Firewall | ✅ **Allow HTTP traffic** ✅ **Allow HTTPS traffic** |
| Networking → Network interfaces → default → External IPv4 address | **Reserve static external IP address** → name `mumbai-maxing-ip` → Reserve |

Click **Create**. Write down the **External IP** shown in the VM list.

## 3. Point `maxing.fofmumbai.com` at the server (Netlify DNS)
1. Netlify → **Domains → fofmumbai.com → DNS settings → Add new record**.
2. Record type **A** · Name **maxing** · Value **the External IP** · TTL default → **Save**.
3. It's usually live within a few minutes. Check at <https://dnschecker.org/#A/maxing.fofmumbai.com>.

## 4. Allow the new address for Google sign‑in
Google Auth Platform → **Clients → Mumbai Maxing server** → under **Authorized redirect URIs**, click **Add URI**:
```
https://maxing.fofmumbai.com/oauth/google/callback
```
Keep the existing `http://localhost:3000/…` entry and **Save**.

## 5. Upload and install
1. On your Mac, build the upload files:
   ```bash
   cd ~/Desktop/mumbaimaxing && bash deploy/package.sh
   ```
   This creates `dist/` containing `mumbaimaxing-deploy.tar.gz`, `setup.sh` and `google-oauth-client.json`.
2. Cloud console → **Compute Engine → VM instances** → click **SSH** next to `mumbai-maxing`. A terminal opens in the browser.
3. In that window, click **⬆ Upload file** (top right) and select **all three files** from `dist/`.
4. Run:
   ```bash
   sudo bash setup.sh
   ```
   Enter `maxing.fofmumbai.com` as the domain, then choose a strong organiser password (you type it twice).
   It takes about 3 minutes and finishes with "✅ Mumbai Maxing is installed".
5. Delete `dist/google-oauth-client.json` from your Mac afterwards. The original stays in `secrets/`.

## 6. Connect Drive and test
1. Open **https://maxing.fofmumbai.com/admin**, log in, then **Settings → Connect Google Drive** → hello.fofmumbai@gmail.com.
2. On a phone, open **https://maxing.fofmumbai.com**, join a team, and submit a photo. Check that it shows up in the dashboard and in Drive.
3. **Admin → Teams → Print room codes** prints the codes for the event.

---

## Updating the app later
**Automatic:** push to `main` on GitHub (`fofmumbai/maxxing-logger`). The **Deploy** workflow checks the code, uploads it,
runs `deploy/setup.sh` on the server and confirms the site responds, in about 20 seconds. You can follow it under the repo's **Actions** tab.
Data and settings are kept, and if the new version fails to start, the server rolls back automatically. Pushes that only change `.md` files don't deploy.
You can also run it by hand: **Actions → Deploy → Run workflow**.

It uses a dedicated `deploy` SSH user (public key added under the VM's **Edit → SSH Keys**) and three repo secrets:
`DEPLOY_HOST`, `DEPLOY_SSH_KEY` (private key, kept locally in `secrets/deploy_key`) and `DEPLOY_KNOWN_HOSTS`.
If the server's IP ever changes, update `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan <ip>`).

**Manual fallback:** run `bash deploy/package.sh` on your Mac, upload `mumbaimaxing-deploy.tar.gz` and `setup.sh` through the SSH window,
then run `sudo bash setup.sh`.

## Handy commands (in the SSH window)
| What | Command |
|---|---|
| Live server log | `sudo journalctl -u mumbaimaxing -f` |
| Restart the app | `sudo systemctl restart mumbaimaxing` |
| Change settings (password, team count…) | `sudo nano /etc/mumbaimaxing/app.env`, then restart |
| Back up the database | `sudo sqlite3 /var/lib/mumbaimaxing/mumbaimaxing.db ".backup /tmp/backup.db"`, then download it with the SSH window's ⬇ button |

## After the event
1. **Admin → Settings → Download CSV** saves all submissions and decisions. The media is already in your Drive.
2. Compute Engine → VM instances → `mumbai-maxing` → **Delete**. Then **VPC network → IP addresses** → release `mumbai-maxing-ip`.
   A reserved IP that isn't attached to a server is billed, so release it.
3. Optionally remove the `maxing` DNS record in Netlify.
