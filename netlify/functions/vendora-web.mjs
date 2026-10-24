import runtime from '../../server/netlify-runtime.cjs';
let app;
export default async (request, context) => {
  app ||= runtime.createWebRuntime();
  return app.handle(request, context);
};
export const config = {
  path: ['/api/intelligence', '/api/member-intelligence', '/api/reprice-coach', '/api/reprice-coach/preferences', '/api/support/ticket', '/price-guides', '/price-guides/*'],
};
