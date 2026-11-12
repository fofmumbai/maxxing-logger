# Mumbai Maxing — FoF Mumbai task logger (PWA)

Teams join with a room code, capture photos/videos for tasks, and organisers approve or reject them live.

- **Team app:** `/`, an installable PWA (Add to Home Screen)
- **Organiser dashboard:** `/admin`

## Run locally

```bash
npm install
ADMIN_PASSWORD=yourpassword npm start
# open http://localhost:3000 and http://localhost:3000/admin
```

On first start it creates **25 teams with random 6-character room codes** and **50 starter tasks**.
Find the codes in Admin → Teams. You can print them or copy a join link like `https://your-site/?code=ABC123`.
Edit, add or delete tasks in Admin → Tasks.

## How it works

| | |
|---|---|
| Join | Room code + name. 4 members max per team. Rejoining with the same name (on a new phone) gets the same seat back. |
| Submit | Tap a task, then **Take photo** / **Record video** (camera only, no gallery). Add as many as you like, then send. Photos are compressed on the phone before upload. |
| Review | Organisers see a live queue (with a chime). Approve, or reject with a required comment. |
| Feedback | The team gets an instant toast, vibration and (if allowed) a notification. A rejected task can be resubmitted. |
| Score | Points count only for approved tasks. A task can be approved once per team. |
| Settings | Show/hide the leaderboard for teams, close submissions when time's up, export a CSV. |

### Camera-only enforcement
The app has its own camera screen (live viewfinder via `getUserMedia`, photo shutter, video recording). There is no
file picker anywhere, so the gallery can't be used on any device. The camera needs HTTPS (or `localhost`).

## Google Drive storage (optional)
Submitted photos and videos can be saved to a Shared Drive in your Google Workspace, sorted into
`Team / #N Task /` folders, with the server's local copy deleted once Drive has the file.
Setup steps are in **[DRIVE_SETUP.md](DRIVE_SETUP.md)**. Without it, media stays on the server's disk.

## Deploying for the event

Phones only allow camera access and PWA install over **HTTPS**. Use any Node host with a **persistent disk**:

- **Railway / Render / Fly.io:** set `ADMIN_PASSWORD`, mount a volume, and set `DATA_DIR` to the mount path.
- **VPS:** `npm install && ADMIN_PASSWORD=... DATA_DIR=/var/mumbaimaxing npm start` behind Caddy/Nginx (HTTPS).
  With Nginx, set `client_max_body_size 1g;` and `proxy_buffering off;` (for live updates).

Storage: photos are compressed on the phone to 500 KB – 1 MB (1 MB hard cap), and videos are recorded at 720p to about 9 MB a minute.
A full event (25 teams × 50 tasks) typically uses 5–15 GB, so a 20–25 GB disk is comfortable.
Back up the `data/` folder after the event; it holds everything (SQLite DB and media).

## Brand
Built from the FoF Mumbai guidelines (fofmumbai.com/brand): Figma Sans Regular/Bold,
Blue `#4D49FC`, Black `#1E1E1E`, Off-white `#F5F5F5`, and Lime / Coral / Kelly Green / Orange accents.
The pill shapes echo the logo.
