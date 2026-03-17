const { createProxyMiddleware } = require('http-proxy-middleware');

const PROXY_TARGET = 'http://localhost:8000';
const PROXY_PREFIXES = [
  '/upload',
  '/meta',
  '/public',
  '/violin',
  '/atlas',
  '/atlas_uv',
  '/prewarm',
  '/features',
  '/llm',
  '/cluster_dominant_annotations',
];

module.exports = function (app) {
  app.use(
    createProxyMiddleware({
      target: PROXY_TARGET,
      changeOrigin: true,
      pathFilter: (pathname) =>
        PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix)),
    })
  );
};
