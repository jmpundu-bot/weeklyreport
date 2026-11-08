# CAMFED Zambia Weekly Activity Portal

This app includes server-side account authentication and saves weekly submissions on the server. Run it with a supported Node.js installation.

Administrators must assign an existing active user or administrator as Line Manager when creating or editing accounts. Assigning the administrator is available for initial setup before a user account exists to act as the first Line Manager. Assigned managers have a separate report review area. They save feedback as a draft, explicitly send it to the submitter, and the submitter can reply. Reports and the full feedback thread remain in the server records.

Each weekday report includes an activity status and a table with Activity, Action, Date By, Progress Update, Follow-up Action, and Comments fields. Submitted records retain each field under its weekday.

## Start the portal

Add the first administrator credentials to the local `.env` file, then start the server:

```powershell
notepad .env
node server.js
```

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`. Use a unique password with at least 12 characters. The local `.env` file is ignored by Git. Environment variables provided by the host take precedence over values in `.env`.

Open `http://localhost:3000`. The administrator can create user accounts from the Admin Dashboard. User email addresses are their usernames. Reports and account records are kept in the ignored `data/records.json` file. Keep that file private and back it up securely.

Use HTTPS and set `NODE_ENV=production` when hosting the portal publicly so the session cookie is marked Secure. The server process must stay running; static-only hosting cannot provide authentication or shared report storage.



## Email notifications

The portal sends individual notifications for new Community Engagement posts (to other active users), sent Line Manager feedback (to the report owner), and activity assignments, edits, deadline changes, or Line Manager replies (to affected assignees). Draft feedback does not notify the report owner.

Configure authenticated SMTP in `.env` using `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_STARTTLS`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. Set `APP_BASE_URL` to the address recipients can open; its default is the local `http://localhost:3000`. Copy the variable names and example format from `.env.example`, and replace the example values with credentials from your organization mail provider. Email delivery remains disabled until the SMTP settings are valid. Keep `.env` private.
