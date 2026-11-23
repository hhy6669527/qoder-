// The test build runs the real game engine through dev/server.mjs and SQLite.
// A Sites database adapter is deliberately not fabricated or silently mocked.
// Before a hosted release, replace this guard with the verified Function adapter.
export function handler(_request: Request): Response {
  return Response.json(
    { error: { code: 'HOSTED_BACKEND_NOT_CONFIGURED', message: '此版本为本地测试版，云端房间服务尚未配置。请使用本地测试入口。' } },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
