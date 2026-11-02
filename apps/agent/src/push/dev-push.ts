/**
 * The push services of local development (a loopback http PUBLIC_URL, as for
 * the mock AI and the breach check): every post is answered "201 Created"
 * without reaching the network, so `npm run dev` and the e2e tests never call
 * a real push service with a made-up subscription. The message is still
 * encrypted and signed, so the code path is the deploy's up to the network.
 * A deploy with an https PUBLIC_URL always posts for real.
 */
export async function developmentPushFetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Read the body so a broken encryption still fails here as it would there.
  if (init?.body) await new Response(init.body).arrayBuffer();
  void input;
  return new Response(null, { status: 201 });
}
