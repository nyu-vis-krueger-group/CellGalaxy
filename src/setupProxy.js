const { createProxyMiddleware } = require("http-proxy-middleware");

/** Long-running channel_list upload + generate_json_files can take many minutes. */
const LONG_TIMEOUT_MS = 60 * 60 * 1000;

module.exports = function setupProxy(app) {
  app.use(
    [
      "/upload",
      "/generation-status",
      "/meta",
      "/coords",
      "/channels",
      "/atlas_uv",
      "/atlas",
      "/public",
      "/violin",
      "/features",
      "/llm",
      "/core_metadata",
      "/output.zarr",
      "/raw.json",
    ],
    createProxyMiddleware({
      target: "http://localhost:8000",
      changeOrigin: true,
      proxyTimeout: LONG_TIMEOUT_MS,
      timeout: LONG_TIMEOUT_MS,
    })
  );
};
