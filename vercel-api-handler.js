const { handleVercelRequest } = require('./server');

module.exports = async (req, res) => {
  try {
    await handleVercelRequest(req, res);
  } catch (error) {
    console.error('Vercel API request failed:', error.message);
    const missingDatabase = !process.env.DATABASE_URL;
    const message = missingDatabase
      ? 'DATABASE_URL is not configured for this deployment.'
      : error.message.includes('Initialize Neon from the local records')
        ? error.message
        : 'The API could not connect to Neon.';
    res.writeHead(missingDatabase ? 503 : 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  }
};
