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

Email notifications are sent individually to people connected to the event. Activity notices go to affected assignees, the activity owner and assigned Line Managers, Senior users with supervisory scope, and Heads responsible for the affected departments. Report submissions, sent feedback, and replies go to the report owner and assigned Line Manager plus relevant Seniors and the Head for that department. Private report chat goes only to its named recipient. Staff Engagement comments and replies notify people already participating in that thread; general posts do not email uninvolved staff. The person who triggered an event is not emailed about their own action, and drafts do not trigger email.

Configure authenticated SMTP in `.env` using `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_STARTTLS`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Set `APP_BASE_URL` to an address recipients can open. Email delivery remains disabled until the SMTP settings are valid. Keep `.env` private.

Vercel runs the protected deadline reminder job daily at 06:00 UTC (08:00 in Zambia). Configure `CRON_SECRET` in the Vercel project environment to a long random value; Vercel sends it as a Bearer token to the reminder endpoint. The job sends reminders one day before and on the due date to active assignees who have not completed the activity and their relevant supervisors. Reminder delivery is tracked per deadline and recipient to avoid duplicate emails.
