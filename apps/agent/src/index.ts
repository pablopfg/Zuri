// Placeholder entry point so the workspace builds and tests from step 0.
// Step 1 replaces it with the Worker, the Durable Object and the security gates.
export default {
  async fetch(_request: Request): Promise<Response> {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  },
};
