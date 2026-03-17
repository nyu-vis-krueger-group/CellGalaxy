const { createProxyMiddleware } = require('http-proxy-middleware');


module.exports = function (app) {
  const proxyTarget = 'http://localhost:8000';
  const pathPrefixes = [
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
  app.use(
    pathPrefixes,
    createProxyMiddleware({
      target: proxyTarget,
      changeOrigin: true,
    })
  );
};
