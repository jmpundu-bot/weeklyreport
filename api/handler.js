module.exports = async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const originalPath = requestUrl.searchParams.get('__route');

  if (originalPath && originalPath.startsWith('/api/')) {
    requestUrl.searchParams.delete('__route');
    req.url = `${originalPath}${requestUrl.search}`;
  }

  return require('../vercel-api-handler.js')(req, res);
};
