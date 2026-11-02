// Makes the installation's VAPID key pair for Web Push (step 11b). Run it once,
// on your own computer, and store each line as a Worker secret:
//
//   node scripts/gerar-chaves-vapid.ts
//   npx wrangler secret put VAPID_PUBLIC_KEY    (paste the first value)
//   npx wrangler secret put VAPID_PRIVATE_KEY   (paste the second value)
//
// Nothing is written to disk or sent anywhere. Changing the pair later makes
// every device subscribe again (Settings > Notifications).

import { Buffer } from "node:buffer";

const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("base64url");
const { d } = await crypto.subtle.exportKey("jwk", keys.privateKey);

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${d}`);
