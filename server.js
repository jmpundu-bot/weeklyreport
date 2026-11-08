const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { neon, Pool } = require('@neondatabase/serverless');

// Load local settings without replacing values supplied by the hosting environment.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const entry = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (entry && process.env[entry[1]] === undefined) process.env[entry[1]] = entry[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const port = Number(process.env.PORT || 3000);
const dbFile = path.join(__dirname, 'data', 'records.json');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const departments = ['IT', 'MERL', 'Programmes', 'Finance', 'People & Culture'];
const reportDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const reportStatuses = ['Not Started', 'In Progress', 'Completed', 'On Hold', 'Not Applicable'];
const reportFields = ['activity', 'action', 'dateBy', 'progressUpdate', 'followUpAction', 'comments'];
const emptyDatabase = () => ({ users: [], reports: [], activities: [], drafts: [], publicHolidays: [], communityPosts: [], sessions: [] });
let db = emptyDatabase();
let sql;
let pool;
let persistenceQueue = Promise.resolve();
function normalizeDatabase(source) {
  const normalized = source && typeof source === 'object' ? source : emptyDatabase();
  for (const key of ['users', 'reports', 'activities', 'drafts', 'publicHolidays', 'communityPosts', 'sessions']) if (!Array.isArray(normalized[key])) normalized[key] = [];
  let migratedReviews = false;
  for (const report of normalized.reports) {
    if (!Array.isArray(report.feedback)) {
      report.feedback = (Array.isArray(report.comments) ? report.comments : []).map(comment => ({ id: comment.id || crypto.randomUUID(), authorId: comment.authorId, authorName: comment.authorName, text: comment.text, createdAt: comment.createdAt, sentAt: comment.createdAt, replies: [] }));
      migratedReviews = true;
    }
    for (const feedback of report.feedback) if (!Array.isArray(feedback.replies)) feedback.replies = [];
  }
  return { database: normalized, migratedReviews };
}
async function initializeDatabase() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('DATABASE_URL is required. Add your Neon PostgreSQL connection string to .env.');
  if (!sql) {
    sql = neon(connectionString);
    pool = new Pool({ connectionString, max: 2 });
    await sql`CREATE TABLE IF NOT EXISTS camfed_report_state (id smallint PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
    await pool.query('CREATE TABLE IF NOT EXISTS camfed_report_assets (id text PRIMARY KEY, content_type text NOT NULL, data bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
  }
  let rows = await sql`SELECT data FROM camfed_report_state WHERE id = 1`;
  if (!rows.length && process.env.VERCEL && !fs.existsSync(dbFile)) throw new Error('Initialize Neon from the local records before serving Vercel requests.');
  if (!rows.length) {
    let initial = emptyDatabase();
    if (fs.existsSync(dbFile)) initial = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    db = normalizeDatabase(initial).database;
    await persist();
    rows = await sql`SELECT data FROM camfed_report_state WHERE id = 1`;
  }
  if (!rows.length) throw new Error('Neon did not return the application data row after initialization.');
  const normalized = normalizeDatabase(rows[0].data);
  db = normalized.database;
  if (normalized.migratedReviews || databaseHasInlineAssets(db)) await persist();
}
function parseDataUri(value) {
  const match = String(value || '').match(/^data:([\w.+/-]+);base64,([A-Za-z0-9+/]+=*)$/);
  return match ? { contentType: match[1], encoded: match[2] } : null;
}
function databaseHasInlineAssets(database) {
  return database.users.some(user => Boolean(parseDataUri(user.profilePicture))) || database.communityPosts.some(post => (post.attachments || []).some(item => Boolean(parseDataUri(item.data))));
}
function persist() {
  if (!sql || !pool) return Promise.reject(new Error('The Neon database is not initialized.'));
  const snapshot = JSON.parse(JSON.stringify(db));
  const assets = [];
  for (const user of snapshot.users) {
    const asset = parseDataUri(user.profilePicture);
    if (asset) {
      const id = 'profile:' + user.id;
      assets.push({ id, ...asset });
      user.profilePictureAssetId = id;
      delete user.profilePicture;
    }
  }
  for (const post of snapshot.communityPosts) for (const attachment of post.attachments || []) {
    const asset = parseDataUri(attachment.data);
    if (asset) {
      const id = 'community:' + attachment.id;
      assets.push({ id, ...asset });
      attachment.assetId = id;
      delete attachment.data;
    }
  }
  const serialized = JSON.stringify(snapshot);
  persistenceQueue = persistenceQueue.catch(() => {}).then(async () => {
    for (const asset of assets) await pool.query('INSERT INTO camfed_report_assets (id, content_type, data, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = now()', [asset.id, asset.contentType, Buffer.from(asset.encoded, 'base64')]);
    for (const user of db.users) {
      const saved = snapshot.users.find(item => item.id === user.id);
      if (saved?.profilePictureAssetId && user.profilePicture) { user.profilePictureAssetId = saved.profilePictureAssetId; delete user.profilePicture; }
    }
    for (const post of db.communityPosts) {
      const saved = snapshot.communityPosts.find(item => item.id === post.id);
      for (const attachment of post.attachments || []) {
        const savedAttachment = saved?.attachments?.find(item => item.id === attachment.id);
        if (savedAttachment?.assetId && attachment.data) { attachment.assetId = savedAttachment.assetId; delete attachment.data; }
      }
    }
    await sql`INSERT INTO camfed_report_state (id, data, updated_at) VALUES (1, ${serialized}::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
  });
  return persistenceQueue;
}
async function readAssetDataUri(assetId) {
  if (!assetId || !pool) return null;
  const result = await pool.query('SELECT content_type, data FROM camfed_report_assets WHERE id = $1', [assetId]);
  const asset = result.rows[0];
  return asset ? 'data:' + asset.content_type + ';base64,' + Buffer.from(asset.data).toString('base64') : null;
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve({ salt, hash: key.toString('hex') })));
}
async function verifyPassword(password, record) {
  const key = await hashPassword(password, record.salt);
  return crypto.timingSafeEqual(Buffer.from(key.hash, 'hex'), Buffer.from(record.hash, 'hex'));
}
function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function readBody(req, maxSize = 500000) {
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) { try { return Promise.resolve(JSON.parse(req.body.toString('utf8') || '{}')); } catch { return Promise.reject(new Error('Invalid JSON')); } }
    if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body || '{}')); } catch { return Promise.reject(new Error('Invalid JSON')); } }
    if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let body = ''; req.on('data', chunk => { body += chunk; if (body.length > maxSize) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function smtpSettings() {
  return {
    host: String(process.env.SMTP_HOST || '').trim(),
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    startTls: String(process.env.SMTP_STARTTLS || 'true').toLowerCase() !== 'false',
    username: String(process.env.SMTP_USER || ''),
    password: String(process.env.SMTP_PASSWORD || ''),
    from: String(process.env.SMTP_FROM || '').trim()
  };
}
function smtpChannel(socket) {
  let buffer = '';
  let responseLines = [];
  let terminalError = null;
  const queued = [];
  const waiters = [];
  const deliver = response => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(response); else queued.push(response);
  };
  const onData = chunk => {
    buffer += chunk.toString('utf8');
    let boundary;
    while ((boundary = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      responseLines.push(line);
      if (/^\d{3} /.test(line)) { deliver(responseLines.join('\r\n')); responseLines = []; }
    }
  };
  const onError = error => {
    terminalError = error;
    while (waiters.length) waiters.shift().reject(error);
  };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', () => { if (!terminalError) onError(new Error('SMTP connection closed unexpectedly.')); });
  function response() {
    if (queued.length) return Promise.resolve(queued.shift());
    if (terminalError) return Promise.reject(terminalError);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }
  function expect(reply, codes) {
    const code = Number(String(reply).slice(0, 3));
    if (!codes.includes(code)) throw new Error('SMTP server returned ' + code + '.');
    return reply;
  }
  async function command(line, codes) {
    const pending = response();
    socket.write(line + '\r\n');
    return expect(await pending, codes);
  }
  async function sendData(value, codes) {
    const pending = response();
    socket.write(value + '\r\n.\r\n');
    return expect(await pending, codes);
  }
  return { response, command, sendData, detach: () => { socket.removeListener('data', onData); socket.removeListener('error', onError); } };
}
function waitForSocket(socket, eventName) {
  return new Promise((resolve, reject) => {
    const onError = error => { socket.removeListener(eventName, onReady); reject(error); };
    const onReady = () => { socket.removeListener('error', onError); resolve(); };
    socket.once(eventName, onReady);
    socket.once('error', onError);
  });
}
function dashboardLink(view) {
  const base = String(process.env.APP_BASE_URL || ('http://localhost:' + port)).trim().replace(/\/+$/, '');
  return base + '/?dashboard=' + encodeURIComponent(view);
}
async function sendSmtpEmail(to, subject, body) {
  const config = smtpSettings();
  if (!config.host || !config.from || !config.username || !config.password || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('SMTP settings are incomplete.');
  const host = config.host;
  let socket = config.secure ? tls.connect({ host, port: config.port, servername: host }) : net.connect({ host, port: config.port });
  socket.setTimeout(30000, () => socket.destroy(new Error('SMTP connection timed out.')));
  let channel = smtpChannel(socket);
  await waitForSocket(socket, config.secure ? 'secureConnect' : 'connect');
  await channel.response().then(reply => { if (Number(reply.slice(0, 3)) !== 220) throw new Error('SMTP greeting failed.'); });
  await channel.command('EHLO localhost', [250]);
  if (!config.secure && config.startTls) {
    await channel.command('STARTTLS', [220]);
    channel.detach();
    socket = tls.connect({ socket, servername: host });
    socket.setTimeout(30000, () => socket.destroy(new Error('SMTP connection timed out.')));
    channel = smtpChannel(socket);
    await waitForSocket(socket, 'secureConnect');
    await channel.command('EHLO localhost', [250]);
  }
  await channel.command('AUTH LOGIN', [334]);
  await channel.command(Buffer.from(config.username, 'utf8').toString('base64'), [334]);
  await channel.command(Buffer.from(config.password, 'utf8').toString('base64'), [235]);
  const fromAddress = (config.from.match(/<([^<>]+)>/) || [null, config.from])[1].replace(/[\r\n]/g, '');
  const recipient = String(to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error('A valid sender and recipient email address are required.');
  await channel.command('MAIL FROM:<' + fromAddress + '>', [250]);
  await channel.command('RCPT TO:<' + recipient + '>', [250, 251]);
  await channel.command('DATA', [354]);
  const encodedBody = Buffer.from(String(body), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  const encodedSubject = '=?UTF-8?B?' + Buffer.from(String(subject), 'utf8').toString('base64') + '?=';
  const headers = [
    'From: ' + config.from.replace(/[\r\n]/g, ' '),
    'To: ' + recipient,
    'Subject: ' + encodedSubject,
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ];
  await channel.sendData(headers.join('\r\n') + '\r\n\r\n' + encodedBody, [250]);
  await channel.command('QUIT', [221]).catch(() => {});
  socket.end();
}
let warnedEmailNotConfigured = false;
function queueEmailNotifications(recipients, notice) {
  const config = smtpSettings();
  if (!config.host || !config.from || !config.username || !config.password) {
    if (!warnedEmailNotConfigured) {
      console.warn('Email notifications are disabled until SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM are configured.');
      warnedEmailNotConfigured = true;
    }
    return;
  }
  const unique = [...new Map((recipients || []).filter(person => person && person.active !== false && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(person.email || ''))).map(person => [person.email.toLowerCase(), person])).values()];
  if (!unique.length) return;
  const makeBody = person => [notice.type, '', typeof notice.description === 'function' ? notice.description(person) : notice.description, '', 'Responsible: ' + notice.actor, '', 'Open this section: ' + dashboardLink(notice.dashboard)].join('\n');
  setImmediate(async () => {
    for (let index = 0; index < unique.length; index += 4) {
      const results = await Promise.allSettled(unique.slice(index, index + 4).map(person => sendSmtpEmail(person.email, notice.subject, makeBody(person))));
      for (const result of results.filter(item => item.status === 'rejected')) console.error('Email notification delivery failed:', result.reason?.message || 'Unknown SMTP error.');
    }
  });
}

function publicUser(user) {
  const { password, ...safe } = user;
  safe.isLineManager = db.users.some(item => item.lineManagerId === user.id) || db.reports.some(report => report.lineManagerId === user.id);
  return safe;
}
function normalizeCommunityReactions(reactions = {}) {
  const normalized = { ...(reactions || {}) };
  for (const [oldKey, emoji] of [["like", "\u{1F44D}"], ["celebrate", "\u{1F389}"], ["support", "\u{1F64F}"]]) {
    if (Array.isArray(normalized[oldKey])) { normalized[emoji] = [...new Set([...(Array.isArray(normalized[emoji]) ? normalized[emoji] : []), ...normalized[oldKey]])]; delete normalized[oldKey]; }
  }
  return normalized;
}
function currentUser(req) {
  const sid = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  const session = sid && db.sessions.find(item => item.id === sid);
  if (!session || session.expires < Date.now()) return null;
  return db.users.find(user => user.id === session.userId && user.active !== false) || null;
}
async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email && !password) return;
  if (!email || password.length < 12) throw new Error('Set both ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters).');
  const existing = db.users.find(user => user.email === email);
  if (existing) {
    const changed = existing.role !== 'admin' || existing.active === false;
    existing.role = 'admin';
    existing.active = true;
    if (changed) await persist();
  } else {
    db.users.push({ id: crypto.randomUUID(), role: 'admin', email, fullName: 'Administrator', department: '', designation: '', active: true, password: await hashPassword(password) });
    await persist();
  }
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/session') {
      const user = currentUser(req); return send(res, 200, { user: user ? publicUser(user) : null });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readBody(req); const email = String(body.email || '').trim().toLowerCase();
      const user = db.users.find(item => item.email === email && item.active !== false);
      const valid = user && await verifyPassword(String(body.password || ''), user.password);
      if (!valid || (body.role === 'admin' && user.role !== 'admin') || (body.role === 'user' && user.role !== 'user')) return send(res, 401, { error: 'Email or password is incorrect for this dashboard.' });
      const sid = crypto.randomBytes(32).toString('hex'); db.sessions = db.sessions.filter(item => item.expires > Date.now()); db.sessions.push({ id: sid, userId: user.id, expires: Date.now() + 8 * 60 * 60 * 1000 }); await persist();
      return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const sid = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1]; if (sid) { const count = db.sessions.length; db.sessions = db.sessions.filter(item => item.id !== sid); if (db.sessions.length !== count) await persist(); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    const user = currentUser(req);
    if (req.method.startsWith('POST') && !['/api/login', '/api/logout'].includes(url.pathname) && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return send(res, 403, { error: 'Request origin rejected.' });
    if (!user && url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Please sign in.' });
    if (url.pathname === '/api/community/posts' && req.method === 'GET') {
      const activeUsers = new Map(db.users.filter(item => item.active !== false).map(item => [item.id, item]));
      const posts = db.communityPosts.filter(post => activeUsers.has(post.authorId)).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(post => ({ ...post, reactions: normalizeCommunityReactions(post.reactions), attachments: (post.attachments || []).map(({ id, name, mimeType }) => ({ id, name, mimeType })), authorName: activeUsers.get(post.authorId).fullName, comments: (post.comments || []).filter(comment => activeUsers.has(comment.authorId)).map(comment => ({ ...comment, authorName: activeUsers.get(comment.authorId).fullName })) }));
      return send(res, 200, { posts, currentUserId: user.id });
    }
    const communityAttachmentMatch = url.pathname.match(/^\/api\/community\/posts\/([\w-]+)\/attachments\/([\w-]+)$/);
    if (req.method === 'GET' && communityAttachmentMatch) {
      const post = db.communityPosts.find(item => item.id === communityAttachmentMatch[1]);
      const attachment = post?.attachments?.find(item => item.id === communityAttachmentMatch[2]);
      if (!attachment) return send(res, 404, { error: 'Attachment not found.' });
      const storedData = attachment.data || await readAssetDataUri(attachment.assetId);
      if (!storedData) return send(res, 404, { error: 'Attachment data not found.' });
      const bytes = Buffer.from(storedData.split(',')[1], 'base64');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
      return res.end(bytes);
    }
    if (url.pathname === '/api/community/posts' && req.method === 'POST') {
      const body = await readBody(req, 700 * 1024 * 1024);
      const text = String(body.text || '').trim();
      const title = String(body.title || '').trim();
      const allowedTypes = ['update', 'story', 'announcement', 'news', 'other'];
      if (!title || title.length > 160 || !text || text.length > 10000 || !allowedTypes.includes(body.type)) return send(res, 400, { error: 'Enter a title, message, and valid post type.' });
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (attachments.length > 10) return send(res, 400, { error: 'Attach up to ten files per post.' });
      const safeAttachments = [];
      for (const attachment of attachments) {
        const name = String(attachment.name || '').replace(/[\\/\0-\x1f]/g, '').slice(0, 180);
        const match = String(attachment.data || '').match(/^data:([\w.+/-]+);base64,([A-Za-z0-9+/]+=*)$/);
        if (!name || !match || Buffer.byteLength(match[2], 'base64') > 50 * 1024 * 1024) return send(res, 400, { error: 'Each attachment must be a valid file no larger than 50 MB.' });
        safeAttachments.push({ id: crypto.randomUUID(), name, mimeType: match[1], data: attachment.data });
      }
      const post = { id: crypto.randomUUID(), authorId: user.id, type: body.type, title, text, attachments: safeAttachments, reactions: {}, comments: [], createdAt: new Date().toISOString() };
      db.communityPosts.push(post); await persist();
      queueEmailNotifications(db.users.filter(person => person.id !== user.id), { type: 'Community Engagement', subject: 'Community Engagement: ' + title.slice(0, 120), description: body.type + ': ' + text.slice(0, 600), actor: user.fullName, dashboard: 'community' });
      return send(res, 201, { ok: true, post: { ...post, authorName: user.fullName } });
    }
    const communityPostMatch = url.pathname.match(/^\/api\/community\/posts\/([\w-]+)$/);
    if (communityPostMatch && ['PUT', 'DELETE'].includes(req.method)) {
      const post = db.communityPosts.find(item => item.id === communityPostMatch[1] && item.authorId === user.id);
      if (!post) return send(res, 404, { error: 'Your post was not found.' });
      if (req.method === 'DELETE') { db.communityPosts = db.communityPosts.filter(item => item.id !== post.id); await persist(); return send(res, 200, { ok: true }); }
      const body = await readBody(req, 700 * 1024 * 1024);
      const text = String(body.text || '').trim(); const title = String(body.title || '').trim();
      if (!title || title.length > 160 || !text || text.length > 10000 || !['update', 'story', 'announcement', 'news', 'other'].includes(body.type)) return send(res, 400, { error: 'Enter a title, message, and valid post type.' });
      post.title = title; post.text = text; post.type = body.type; post.updatedAt = new Date().toISOString();
      if (Array.isArray(body.attachments)) {
        if (body.attachments.length > 10) return send(res, 400, { error: 'Attach up to ten files per post.' });
        const safeAttachments = [];
        for (const attachment of body.attachments) {
          if (attachment.id && post.attachments.some(item => item.id === attachment.id)) safeAttachments.push(post.attachments.find(item => item.id === attachment.id));
          else {
            const name = String(attachment.name || '').replace(/[\\/\0-\x1f]/g, '').slice(0, 180);
            const match = String(attachment.data || '').match(/^data:([\w.+/-]+);base64,([A-Za-z0-9+/]+=*)$/);
            if (!name || !match || Buffer.byteLength(match[2], 'base64') > 50 * 1024 * 1024) return send(res, 400, { error: 'Each attachment must be a valid file no larger than 50 MB.' });
            safeAttachments.push({ id: crypto.randomUUID(), name, mimeType: match[1], data: attachment.data });
          }
        }
        post.attachments = safeAttachments;
      }
      await persist(); return send(res, 200, { ok: true });
    }
    const communityReactionMatch = url.pathname.match(/^\/api\/community\/posts\/([\w-]+)\/reactions$/);
    if (communityReactionMatch && req.method === 'POST') {
      const post = db.communityPosts.find(item => item.id === communityReactionMatch[1]);
      if (!post) return send(res, 404, { error: 'Post not found.' });
      const body = await readBody(req); const reaction = String(body.reaction || '');
      if (!["\u{1F44D}","\u2764\uFE0F","\u{1F602}","\u{1F62E}","\u{1F622}","\u{1F64F}","\u{1F44F}","\u{1F525}","\u{1F389}","\u{1F60D}","\u{1F970}","\u{1F914}","\u{1F621}","\u{1F64C}","\u{1F4AA}","\u{1F4AF}","\u{1F440}","\u2705","\u2728","\u{1F91D}","\u{1F917}","\u{1F606}","\u{1F615}","\u2764\uFE0F\u200D\u{1F525}"].includes(reaction)) return send(res, 400, { error: 'Choose a valid reaction.' });
      post.reactions = normalizeCommunityReactions(post.reactions);
      const users = Array.isArray(post.reactions[reaction]) ? post.reactions[reaction] : [];
      post.reactions[reaction] = users.includes(user.id) ? users.filter(id => id !== user.id) : [...users, user.id];
      await persist(); return send(res, 200, { reactions: post.reactions });
    }
    const communityCommentMatch = url.pathname.match(/^\/api\/community\/posts\/([\w-]+)\/comments$/);
    if (communityCommentMatch && req.method === 'POST') {
      const post = db.communityPosts.find(item => item.id === communityCommentMatch[1]);
      if (!post) return send(res, 404, { error: 'Post not found.' });
      const body = await readBody(req); const text = String(body.text || '').trim();
      if (!text || text.length > 3000) return send(res, 400, { error: 'Enter a comment of 1 to 3,000 characters.' });
      if (!Array.isArray(post.comments)) post.comments = [];
      post.comments.push({ id: crypto.randomUUID(), authorId: user.id, text, createdAt: new Date().toISOString() });
      await persist(); return send(res, 201, { ok: true });
    }
    if (url.pathname === '/api/my/profile-picture') {
      if (req.method === 'GET') return send(res, 200, { picture: user.profilePicture || await readAssetDataUri(user.profilePictureAssetId) || null });
      if (req.method === 'PUT') {
        const body = await readBody(req, 42 * 1024 * 1024);
        const picture = String(body.picture || '');
        const match = picture.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/);
        if (!match) return send(res, 400, { error: 'Upload a PNG, JPEG, or WebP image.' });
        const bytes = Buffer.from(match[2], 'base64');
        if (!bytes.length || bytes.length > 30 * 1024 * 1024) return send(res, 400, { error: 'The profile picture must be 30 MB or smaller.' });
        user.profilePicture = picture; await persist(); return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') { delete user.profilePicture; delete user.profilePictureAssetId; await persist(); return send(res, 200, { ok: true }); }
    }
    if (url.pathname === '/api/my/draft') {
      if (user.role !== 'user') return send(res, 403, { error: 'User dashboard access required.' });
      if (req.method === 'GET') {
        const week = url.searchParams.get('week') || '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return send(res, 400, { error: 'Choose a valid week commencing date.' });
        const draft = db.drafts.find(item => item.userId === user.id && item.weekCommencing === week);
        return send(res, 200, { draft: draft || null });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req); const week = String(body.weekCommencing || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !body.fields || typeof body.fields !== 'object') return send(res, 400, { error: 'A valid week and draft fields are required.' });
        const fields = {};
        for (const day of reportDays) {
          const prefix = day.toLowerCase();
          fields[`status-${prefix}`] = reportStatuses.includes(body.fields[`status-${prefix}`]) ? body.fields[`status-${prefix}`] : '';
          for (const key of reportFields) fields[`${prefix}-${key}`] = String(body.fields[`${prefix}-${key}`] || '').slice(0, 10000);
        }
        const existing = db.drafts.find(item => item.userId === user.id && item.weekCommencing === week);
        if (existing) { existing.fields = fields; existing.updatedAt = new Date().toISOString(); }
        else db.drafts.push({ userId: user.id, weekCommencing: week, fields, updatedAt: new Date().toISOString() });
        await persist(); return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        const week = url.searchParams.get('week') || '';
        db.drafts = db.drafts.filter(item => item.userId !== user.id || item.weekCommencing !== week);
        await persist(); return send(res, 200, { ok: true });
      }
    }
    if (url.pathname.startsWith('/api/admin/')) {
      if (user.role !== 'admin') return send(res, 403, { error: 'Administrator access required.' });
      if (url.pathname === '/api/admin/holidays' && req.method === 'GET') return send(res, 200, { holidays: db.publicHolidays.slice().sort((a, b) => a.date.localeCompare(b.date)) });
      if (url.pathname === '/api/admin/holidays' && req.method === 'POST') {
        const body = await readBody(req); const date = String(body.date || ''); const name = String(body.name || '').trim().slice(0, 100);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return send(res, 400, { error: 'Enter a valid public holiday date.' });
        if (db.publicHolidays.some(item => item.date === date)) return send(res, 400, { error: 'That date is already designated as a public holiday.' });
        db.publicHolidays.push({ date, name }); await persist(); return send(res, 201, { holiday: { date, name } });
      }
      const holidayMatch = url.pathname.match(/^\/api\/admin\/holidays\/(\d{4}-\d{2}-\d{2})$/);
      if (holidayMatch) {
        const holiday = db.publicHolidays.find(item => item.date === holidayMatch[1]);
        if (!holiday) return send(res, 404, { error: 'Public holiday not found.' });
        if (req.method === 'PUT') {
          const body = await readBody(req); const date = String(body.date || ''); const name = String(body.name || '').trim().slice(0, 100);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return send(res, 400, { error: 'Enter a valid public holiday date.' });
          if (db.publicHolidays.some(item => item !== holiday && item.date === date)) return send(res, 400, { error: 'That date is already designated as a public holiday.' });
          holiday.date = date; holiday.name = name; await persist(); return send(res, 200, { holiday });
        }
        if (req.method === 'DELETE') { db.publicHolidays = db.publicHolidays.filter(item => item !== holiday); await persist(); return send(res, 200, { ok: true }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/users') return send(res, 200, { users: db.users.filter(item => item.role === 'user').map(publicUser), lineManagers: db.users.filter(item => ['user', 'admin'].includes(item.role) && item.active !== false).map(publicUser) });
      if (req.method === 'POST' && url.pathname === '/api/admin/users') {
        const body = await readBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        const department = String(body.department || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
        if (!departments.includes(department)) return send(res, 400, { error: 'Select a department from the list.' });
        if (password.length < 10) return send(res, 400, { error: 'Password must contain at least 10 characters.' });
        if (db.users.some(item => item.email.toLowerCase() === email)) return send(res, 400, { error: 'That email address already has an account. Use a different email.' });
        const lineManagerId = String(body.lineManagerId || '').trim() || null;
        if (!lineManagerId) return send(res, 400, { error: 'Assign a Line Manager before creating this account.' });
        if (!db.users.some(item => item.id === lineManagerId && ['user', 'admin'].includes(item.role) && item.active !== false)) return send(res, 400, { error: 'Select an active account as Line Manager.' });
        const created = { id: crypto.randomUUID(), role: 'user', email, fullName: String(body.fullName || '').trim(), department, designation: String(body.designation || '').trim(), lineManagerId, active: true, password: await hashPassword(password) };
        db.users.push(created); await persist(); return send(res, 201, { user: publicUser(created) });
      }
      const match = url.pathname.match(/^\/api\/admin\/users\/([\w-]+)$/);
      if (match) {
        const target = db.users.find(item => item.id === match[1] && item.role === 'user'); if (!target) return send(res, 404, { error: 'User not found.' });
        if (req.method === 'PUT') {
          const body = await readBody(req); const email = String(body.email || target.email).trim().toLowerCase();
          if (db.users.some(item => item.id !== target.id && item.email === email)) return send(res, 400, { error: 'That email is already in use.' });
          if (body.department !== undefined && !departments.includes(body.department)) return send(res, 400, { error: 'Select a valid department.' });
          if (body.lineManagerId !== undefined) {
            const lineManagerId = String(body.lineManagerId || '').trim() || null;
            if (!lineManagerId) return send(res, 400, { error: 'Assign a Line Manager to this account.' });
            if (lineManagerId === target.id || !db.users.some(item => item.id === lineManagerId && ['user', 'admin'].includes(item.role) && item.active !== false)) return send(res, 400, { error: 'Select another active account as Line Manager.' });
            target.lineManagerId = lineManagerId;
          }
          target.email = email; target.fullName = String(body.fullName ?? target.fullName).trim(); target.department = String(body.department ?? target.department); target.designation = String(body.designation ?? target.designation);
          if (body.password) { if (String(body.password).length < 10) return send(res, 400, { error: 'Password must have at least 10 characters.' }); target.password = await hashPassword(String(body.password)); }
          if (body.active !== undefined) target.active = Boolean(body.active); await persist(); return send(res, 200, { user: publicUser(target) });
        }
        if (req.method === 'DELETE') {
          // Keep submitted reports and their feedback threads. Route reports and direct reports
          // assigned to a deleted manager to the administrator performing the deletion.
          for (const report of db.reports) if (report.lineManagerId === target.id) { report.originalLineManagerId = target.id; report.lineManagerId = user.id; }
          for (const account of db.users) if (account.id !== target.id && account.lineManagerId === target.id) account.lineManagerId = user.id;
          db.users = db.users.filter(item => item.id !== target.id); await persist(); return send(res, 200, { ok: true });
        }
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/holidays') return send(res, 200, { holidays: db.publicHolidays.slice().sort((a, b) => a.date.localeCompare(b.date)) });
    if (req.method === 'POST' && url.pathname === '/api/reports') {
      if (user.role !== 'user') return send(res, 403, { error: 'User dashboard access required.' });
      const lineManager = db.users.find(item => item.id === user.lineManagerId && item.role === 'user' && item.active !== false);
      if (!lineManager) return send(res, 400, { error: 'Your account needs an active Line Manager. Contact the administrator before submitting.' });
      const report = await readBody(req);
      const weekCommencing = String(report.staff?.weekCommencing || '');
      const parsedWeek = new Date(`${weekCommencing}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(weekCommencing) || Number.isNaN(parsedWeek.valueOf()) || parsedWeek.toISOString().slice(0, 10) !== weekCommencing || parsedWeek.getUTCDay() !== 1 || !Array.isArray(report.activities) || report.activities.length !== reportDays.length) return send(res, 400, { error: 'A valid Monday to Friday report week is required.' });
      if (report.activities.some((entry, index) => entry.day !== reportDays[index])) return send(res, 400, { error: 'A valid Monday to Friday report is required.' });
      const holidayDates = new Set(db.publicHolidays.map(item => item.date));
      for (let index = 0; index < report.activities.length; index++) {
        const date = new Date(`${weekCommencing}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + index);
        const dateKey = date.toISOString().slice(0, 10); const entry = report.activities[index];
        if (holidayDates.has(dateKey) && entry.status !== 'Not Applicable') return send(res, 400, { error: `Activity reporting is disabled for public holiday ${dateKey}.` });
        if (!holidayDates.has(dateKey) && !reportStatuses.includes(entry.status)) return send(res, 400, { error: 'Each working day needs a valid activity status.' });
      }
      const activities = report.activities.map((entry, index) => {
        const date = new Date(`${weekCommencing}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + index);
        const dateKey = date.toISOString().slice(0, 10); const isHoliday = holidayDates.has(dateKey);
        const dayEntry = { day: entry.day, status: entry.status };
        for (const field of reportFields) dayEntry[field] = isHoliday ? '' : String(entry[field] || '').trim();
        return dayEntry;
      });
      if (activities.some((entry, index) => {
        const date = new Date(`${weekCommencing}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + index);
        return !holidayDates.has(date.toISOString().slice(0, 10)) && (!entry.activity || reportFields.some(field => entry[field].length > 10000));
      })) return send(res, 400, { error: 'Enter an activity for each working day. Each table entry must be 10,000 characters or fewer.' });
      report.id = crypto.randomUUID(); report.userId = user.id; report.lineManagerId = lineManager.id; report.submittedAt = new Date().toISOString(); report.staff = { weekCommencing, fullName: user.fullName, department: user.department, designation: user.designation }; report.activities = activities; report.feedback = [];
      db.reports.push(report); await persist(); return send(res, 201, { ok: true, id: report.id });
    }
    if (req.method === 'GET' && url.pathname === '/api/my/reports') {
      if (user.role !== 'user') return send(res, 403, { error: 'User dashboard access required.' });
      const reports = db.reports.filter(report => report.userId === user.id).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).map(report => ({ ...report, feedback: (report.feedback || []).filter(feedback => feedback.sentAt) }));
      return send(res, 200, { reports });
    }
    if (req.method === 'GET' && url.pathname === '/api/my/activities') {
      if (user.role !== 'user') return send(res, 403, { error: 'User dashboard access required.' });
      const activities = db.activities.filter(item => item.lineManagerId === user.lineManagerId && item.assigneeIds.includes(user.id)).map(item => ({ id: item.id, title: item.title, description: item.description, deadline: item.deadline, createdAt: item.createdAt, status: item.statusByUser?.[user.id] || 'Not Started', updates: item.updates.filter(update => update.authorId === user.id || update.recipientId === user.id) }));
      return send(res, 200, { activities });
    }
    const activityUpdateMatch = url.pathname.match(/^\/api\/my\/activities\/([\w-]+)\/updates$/);
    if (req.method === 'POST' && activityUpdateMatch) {
      if (user.role !== 'user') return send(res, 403, { error: 'User dashboard access required.' });
      const activity = db.activities.find(item => item.id === activityUpdateMatch[1] && item.lineManagerId === user.lineManagerId && item.assigneeIds.includes(user.id));
      if (!activity) return send(res, 404, { error: 'Assigned activity not found.' });
      const body = await readBody(req); const text = String(body.text || '').trim(); const status = String(body.status || 'In Progress');
      if (!text || text.length > 5000 || !['Not Started', 'In Progress', 'Completed', 'On Hold'].includes(status)) return send(res, 400, { error: 'Enter an update (up to 5,000 characters) and choose a valid status.' });
      activity.updates.push({ id: crypto.randomUUID(), authorId: user.id, authorName: user.fullName, recipientId: user.id, text, status, createdAt: new Date().toISOString() });
      activity.statusByUser = { ...(activity.statusByUser || {}), [user.id]: status };
      await persist(); return send(res, 201, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/manager/activities') {
      if (!['user', 'admin'].includes(user.role)) return send(res, 403, { error: 'Line Manager access required.' });
      const assignedIds = new Set(db.users.filter(item => item.role === 'user' && item.lineManagerId === user.id && item.active !== false).map(item => item.id));
      return send(res, 200, { assignedUsers: db.users.filter(item => assignedIds.has(item.id)).map(item => ({ id: item.id, fullName: item.fullName, email: item.email })), activities: db.activities.filter(item => item.lineManagerId === user.id).map(item => ({ ...item, assigneeIds: item.assigneeIds.filter(id => assignedIds.has(id)), assignees: item.assigneeIds.filter(id => assignedIds.has(id)).map(id => { const target = db.users.find(account => account.id === id); return target ? { id, fullName: target.fullName } : null; }).filter(Boolean), updates: item.updates.filter(update => assignedIds.has(update.authorId) || (update.recipientId && assignedIds.has(update.recipientId))) })) });
    }
    const managerActivityEditMatch = url.pathname.match(/^\/api\/manager\/activities\/([\w-]+)$/);
    if (req.method === 'PUT' && managerActivityEditMatch) {
      if (!['user', 'admin'].includes(user.role)) return send(res, 403, { error: 'Line Manager access required.' });
      const activity = db.activities.find(item => item.id === managerActivityEditMatch[1] && item.lineManagerId === user.id);
      if (!activity) return send(res, 404, { error: 'Activity not found.' });
      const body = await readBody(req);
      const title = String(body.title || '').trim(); const description = String(body.description || '').trim(); const deadline = String(body.deadline || '');
      const assignedUsers = new Set(db.users.filter(item => item.role === 'user' && item.lineManagerId === user.id && item.active !== false).map(item => item.id));
      const previousAssigneeIds = [...activity.assigneeIds];
      const previousTitle = activity.title; const previousDescription = activity.description; const previousDeadline = activity.deadline;
      const assigneeIds = [...new Set(Array.isArray(body.assigneeIds) ? body.assigneeIds.map(String) : previousAssigneeIds.filter(id => assignedUsers.has(id)))];
      const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(deadline) && !Number.isNaN(Date.parse(deadline + 'T00:00:00Z')) && new Date(deadline + 'T00:00:00Z').toISOString().slice(0, 10) === deadline;
      if (!title || title.length > 200 || !description || description.length > 5000 || !dateValid || !assigneeIds.length || assigneeIds.some(id => !assignedUsers.has(id))) return send(res, 400, { error: 'Enter a title, description, valid deadline, and select only active users assigned to you.' });
      const assignmentChanged = previousAssigneeIds.length !== assigneeIds.length || previousAssigneeIds.some(id => !assigneeIds.includes(id));
      const changed = title !== previousTitle || description !== previousDescription || deadline !== previousDeadline || assignmentChanged;
      if (!changed) return send(res, 200, { activity, changed: false });
      activity.title = title; activity.description = description; activity.deadline = deadline; activity.assigneeIds = assigneeIds; activity.updatedAt = new Date().toISOString();
      await persist();
      const affectedIds = new Set([...previousAssigneeIds, ...assigneeIds]);
      const recipients = db.users.filter(person => affectedIds.has(person.id) && person.active !== false);
      queueEmailNotifications(recipients, { type: 'Deadline Activity Changed', subject: 'Activity updated: ' + title, description: person => (assigneeIds.includes(person.id) ? 'You are assigned to this activity.' : 'You are no longer assigned to this activity.') + '\nActivity: ' + title + '\n' + description + '\nPrevious deadline: ' + previousDeadline + '\nNew deadline: ' + deadline, actor: user.fullName, dashboard: 'assigned' });
      return send(res, 200, { activity });
    }
    const managerActivityReplyMatch = url.pathname.match(/^\/api\/manager\/activities\/([\w-]+)\/assignees\/([\w-]+)\/replies$/);
    if (req.method === 'POST' && managerActivityReplyMatch) {
      if (!['user', 'admin'].includes(user.role)) return send(res, 403, { error: 'Line Manager access required.' });
      const [, activityId, assigneeId] = managerActivityReplyMatch;
      const activity = db.activities.find(item => item.id === activityId && item.lineManagerId === user.id && item.assigneeIds.includes(assigneeId));
      const assignee = db.users.find(item => item.id === assigneeId && item.role === 'user' && item.lineManagerId === user.id && item.active !== false);
      if (!activity || !assignee) return send(res, 404, { error: 'Assigned activity participant not found.' });
      const body = await readBody(req); const text = String(body.text || '').trim();
      if (!text || text.length > 5000) return send(res, 400, { error: 'Enter a reply of 1 to 5,000 characters.' });
      activity.updates.push({ id: crypto.randomUUID(), authorId: user.id, authorName: user.fullName, recipientId: assigneeId, text, status: activity.statusByUser?.[assigneeId] || 'Not Started', createdAt: new Date().toISOString() });
      await persist(); queueEmailNotifications([assignee], { type: 'Deadline Activity Update', subject: 'Activity update: ' + activity.title, description: text + '\nDeadline: ' + activity.deadline, actor: user.fullName, dashboard: 'assigned' }); return send(res, 201, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/manager/activities') {
      if (!['user', 'admin'].includes(user.role)) return send(res, 403, { error: 'Line Manager access required.' });
      const body = await readBody(req); const title = String(body.title || '').trim(); const description = String(body.description || '').trim(); const deadline = String(body.deadline || '');
      const assignedIds = new Set(db.users.filter(item => item.role === 'user' && item.lineManagerId === user.id && item.active !== false).map(item => item.id));
      const assigneeIds = [...new Set(Array.isArray(body.assigneeIds) ? body.assigneeIds.map(String) : [])];
      const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(deadline) && !Number.isNaN(Date.parse(`${deadline}T00:00:00Z`)) && new Date(`${deadline}T00:00:00Z`).toISOString().slice(0, 10) === deadline;
      if (!title || title.length > 200 || !description || description.length > 5000 || !dateValid || !assigneeIds.length || assigneeIds.some(id => !assignedIds.has(id))) return send(res, 400, { error: 'Enter a title, description, valid deadline, and select only active users assigned to you.' });
      const activity = { id: crypto.randomUUID(), lineManagerId: user.id, title, description, deadline, assigneeIds, statusByUser: {}, updates: [], createdAt: new Date().toISOString() };
      db.activities.push(activity); await persist();
      queueEmailNotifications(db.users.filter(person => assigneeIds.includes(person.id)), { type: 'Deadline Activity Assigned', subject: 'New activity: ' + title, description: description + '\nDeadline: ' + deadline, actor: user.fullName, dashboard: 'assigned' });
      return send(res, 201, { activity });
    }
    if (req.method === 'GET' && url.pathname === '/api/manager/reports') {
      if (!['user', 'admin'].includes(user.role)) return send(res, 403, { error: 'Line Manager access required.' });
      const assignedUsers = db.users.filter(item => item.role === 'user' && item.lineManagerId === user.id && item.active !== false).map(item => ({ id: item.id, fullName: item.fullName, email: item.email }));
      const assignedIds = new Set(assignedUsers.map(item => item.id));
      const reports = db.reports.filter(report => report.lineManagerId === user.id && assignedIds.has(report.userId)).map(report => {
        const author = db.users.find(item => item.id === report.userId);
        return { ...report, author: author ? { fullName: author.fullName, email: author.email, department: author.department } : null };
      });
      return send(res, 200, { assignedUsers, reports });
    }
    const feedbackMatch = url.pathname.match(/^\/api\/manager\/reports\/([\w-]+)\/feedback$/);
    if (req.method === 'POST' && feedbackMatch) {
      if (!['user', 'admin'].includes(user.role)) return send(res, 403, { error: 'Line Manager access required.' });
      const report = db.reports.find(item => item.id === feedbackMatch[1] && item.lineManagerId === user.id);
      if (!report) return send(res, 404, { error: 'Assigned report not found.' });
      const body = await readBody(req); const text = String(body.feedback || '').trim();
      if (!text || text.length > 5000) return send(res, 400, { error: 'Enter feedback of 1 to 5,000 characters.' });
      if (!Array.isArray(report.feedback)) report.feedback = [];
      const feedback = { id: crypto.randomUUID(), authorId: user.id, authorName: user.fullName, text, createdAt: new Date().toISOString(), sentAt: null, replies: [] };
      report.feedback.push(feedback); await persist(); return send(res, 201, { feedback });
    }
    const sendFeedbackMatch = url.pathname.match(/^\/api\/manager\/reports\/([\w-]+)\/feedback\/([\w-]+)\/send$/);
    if (req.method === 'POST' && sendFeedbackMatch) {
      if (!['user', 'admin'].includes(user.role)) return send(res, 403, { error: 'Line Manager access required.' });
      const report = db.reports.find(item => item.id === sendFeedbackMatch[1] && item.lineManagerId === user.id);
      const feedback = report?.feedback?.find(item => item.id === sendFeedbackMatch[2]);
      if (!feedback) return send(res, 404, { error: 'Feedback draft not found.' });
      const newlySent = !feedback.sentAt;
      if (newlySent) feedback.sentAt = new Date().toISOString();
      await persist();
      if (newlySent) { const recipient = db.users.find(item => item.id === report.userId && item.active !== false); queueEmailNotifications(recipient ? [recipient] : [], { type: 'Line Manager Feedback', subject: 'Feedback on your weekly report', description: feedback.text, actor: user.fullName, dashboard: 'reports' }); }
      return send(res, 200, { ok: true });
    }
    const replyMatch = url.pathname.match(/^\/api\/my\/reports\/([\w-]+)\/feedback\/([\w-]+)\/replies$/);
    if (req.method === 'POST' && replyMatch) {
      if (user.role !== 'user') return send(res, 403, { error: 'User dashboard access required.' });
      const report = db.reports.find(item => item.id === replyMatch[1] && item.userId === user.id);
      const feedback = report?.feedback?.find(item => item.id === replyMatch[2] && item.sentAt);
      if (!feedback) return send(res, 404, { error: 'Sent feedback not found.' });
      const body = await readBody(req); const text = String(body.reply || '').trim();
      if (!text || text.length > 5000) return send(res, 400, { error: 'Enter a reply of 1 to 5,000 characters.' });
      feedback.replies.push({ id: crypto.randomUUID(), authorId: user.id, authorName: user.fullName, text, createdAt: new Date().toISOString() });
      await persist(); return send(res, 201, { ok: true });
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(__dirname, relative); if (!file.startsWith(`${path.resolve(__dirname)}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, { error: 'Not found.' });
  } catch (error) { console.error(error); send(res, 500, { error: 'The request could not be completed.' }); }}
const server = http.createServer(handleRequest);
async function handleVercelRequest(req, res) {
  await initializeDatabase();
  await bootstrapAdmin();
  return handleRequest(req, res);
}
module.exports = { handleVercelRequest };
if (require.main === module) initializeDatabase().then(bootstrapAdmin).then(() => {
  server.listen(port, () => console.log(`Weekly Activity Portal running at http://localhost:${port}`));
}).catch(error => { console.error(error.message); process.exitCode = 1; });