# CAMFED Zambia Weekly Activity Portal

This Node.js app provides account authentication, weekly reports, activity assignments, report feedback, and Community Engagement.

## Start the portal

1. Create a Neon PostgreSQL project and copy its connection string from the Neon Console.
2. Add `DATABASE_URL` to the local `.env` file, along with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Keep `.env` private and never commit it.
3. Install dependencies and start the app:

```powershell
npm install
npm start
```

Open `http://localhost:3000`. The Node app serves both the interface and `/api/*` routes; Neon provides the database, not web hosting. Vercel deployments use one shared Node function in `api/handler.js`, with `vercel.json` routing all `/api/*` requests to it, staying within the Hobby plan limit of 12 Serverless Functions per deployment. Set `DATABASE_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in the Vercel project environment, and initialize Neon locally first so the existing ignored data file is imported before the hosted function receives requests. Vercel Functions limit request and response bodies to 4.5 MB, so 50 MB attachments need a separate Node web-service route or direct object-storage uploads.

On first startup, if the Neon state table is empty, the app imports `data/records.json` once. The file is retained as a migration backup; new changes are written to Neon. The app stores account/report data in a JSONB state row and photo/document bytes in a separate `BYTEA` table using the Neon driver’s WebSocket pool. Node.js 22 or later is required.

The administrator can create user accounts from the Admin Dashboard. User email addresses are their usernames. Use HTTPS and set `NODE_ENV=production` when hosting the portal publicly so session cookies are marked Secure.

## Email notifications

The portal sends individual notifications for new Community Engagement posts (to other active users), sent Line Manager feedback (to the report owner), and activity assignments, edits, deadline changes, or Line Manager replies (to affected assignees). Draft feedback does not notify the report owner.

Configure authenticated SMTP in `.env` using `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_STARTTLS`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Set `APP_BASE_URL` to an address recipients can open. Email delivery remains disabled until the SMTP settings are valid. Keep `.env` private.