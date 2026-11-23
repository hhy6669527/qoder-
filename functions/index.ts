// _qoder is supplied by the Sites runtime, never by browser code or local fixtures.
import { createDatabaseClient, createSiteContext, errorResponse } from './_qoder/backend.mjs';
import { application } from './cloud-handler.mjs';
import { createCloudStore } from './cloud-store.mjs';
import stories from './story-data.mjs';

const handle = application({
  store: createCloudStore(createDatabaseClient()),
  stories,
  origin: 'https://same-wavelength-fhfo7md2auf.qoder.website',
});
Deno.serve(async (request: Request) => {
  let context;
  try {
    // Keep the application's anonymous room capability in Authorization.
    // We never use browser-provided user IDs or platform headers as membership.
    context = createSiteContext(request, { forwardApplicationCredentials: true });
    return await handle(context.request);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
