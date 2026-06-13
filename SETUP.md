# Neo Group Upload Server — Setup Guide
# Runs on: 168.144.33.40 alongside the form

---

## What this does

Receives file uploads from the form, pushes them directly to your
Google Drive "Neogroup Inquiry Files" folder using your own Google account
via OAuth2. No service account, no base64, no Make complexity.

Flow:
  Browser → POST /upload (multipart files)
         → Node.js server (port 4000, PM2)
         → Google Drive API (OAuth2 — your account)
         → Returns Drive file links
  Browser → POST Make webhook (text fields + Drive links only)
         → Google Sheets row + Gmail email

---

## Step 1 — Google Cloud Console (5 min)

1. console.cloud.google.com → New project → name: "Neogroup Form"
2. APIs & Services → Library → search "Google Drive API" → Enable
3. APIs & Services → OAuth consent screen
   - User type: External
   - App name: Neogroup Form
   - Support email: your email
   - Scopes: add "https://www.googleapis.com/auth/drive.file"
   - Test users: add your Google account email
   - Save
4. APIs & Services → Credentials → Create credentials → OAuth 2.0 Client ID
   - Application type: Web application
   - Name: Neogroup Form Server
   - Authorized redirect URIs: https://form.neogrouplimited.com/oauth/callback
   - Create → copy CLIENT_ID and CLIENT_SECRET

---

## Step 2 — Upload files to droplet

From your local machine:

```bash
# Create directory on server
ssh root@168.144.33.40 "mkdir -p /var/www/neogroup-upload"

# Upload server files
scp server.js package.json .env.example root@168.144.33.40:/var/www/neogroup-upload/
```

---

## Step 3 — Configure on droplet

SSH into the droplet:

```bash
ssh root@168.144.33.40

cd /var/www/neogroup-upload

# Install dependencies
npm install

# Create .env from template
cp .env.example .env
nano .env
```

Fill in .env:
```
CLIENT_ID=paste_from_step_1
CLIENT_SECRET=paste_from_step_1
REDIRECT_URI=https://form.neogrouplimited.com/oauth/callback
DRIVE_FOLDER_ID=your_neogroup_inquiry_files_folder_id
PORT=4000
ALLOWED_ORIGIN=https://form.neogrouplimited.com
TOKEN_PATH=/var/www/neogroup-upload/token.json
```

---

## Step 4 — Start with PM2

```bash
# Install dotenv so PM2 loads .env
npm install dotenv

# Start server with PM2
pm2 start server.js --name neogroup-upload -- -r dotenv/config
pm2 save

# Check it's running
pm2 status
pm2 logs neogroup-upload
```

---

## Step 5 — Update nginx

```bash
nano /etc/nginx/sites-available/neogroup-form
```

Add these two location blocks inside the server { } block,
before the closing brace (copy from nginx-addition.conf):

```nginx
    location /upload {
        proxy_pass         http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        client_max_body_size 100M;
        proxy_read_timeout   120s;
    }

    location /oauth {
        proxy_pass         http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
    }
```

Then reload nginx:
```bash
nginx -t && systemctl reload nginx
```

---

## Step 6 — Authorize (one-time, takes 30 seconds)

Open in your browser:
```
https://form.neogrouplimited.com/oauth/authorize
```

- Google consent screen appears
- Sign in with your Google account (the one with manager access to the Drive folder)
- Allow "drive.file" permission
- You'll see "Authorization successful" page
- Done — token saved to /var/www/neogroup-upload/token.json

The token auto-refreshes forever. You only do this once.

---

## Step 7 — Verify

```bash
curl https://form.neogrouplimited.com/upload/health
# Should return: {"status":"ok","authorized":true}
```

---

## Step 8 — Deploy updated form

```bash
# From local machine
scp index.html root@168.144.33.40:/var/www/neogroup-form/index.html
```

Open the form, fill it in, attach a file, submit.
Check your Drive folder — the file should appear in a new subfolder.

---

## Updating later

```bash
# Code changes on droplet
cd /var/www/neogroup-upload
nano server.js
pm2 restart neogroup-upload
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| health check returns authorized:false | Visit /oauth/authorize again |
| 413 error on upload | Increase client_max_body_size in nginx |
| pm2 not loading .env | Use: pm2 start server.js --name neogroup-upload -- -r dotenv/config |
| Drive permission denied | Re-run /oauth/authorize with the correct Google account |
| token.json missing after restart | PM2 save + TOKEN_PATH must be writable |
