/**
 * The Bot API of local development (a loopback http PUBLIC_URL, as for the
 * mock AI and the push services): every call is answered here, so `npm run
 * dev` and the e2e tests never reach Telegram with a made-up token. The bot is
 * "zuri_local_bot"; the webhook it reports is the last one registered. A
 * deploy with an https PUBLIC_URL always calls Telegram for real.
 */
let webhookUrl = "";

export async function developmentTelegramFetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // A file's download (step 14): a few seconds of silence's worth of bytes, which the mock transcriber hears.
  if (String(input).includes("/file/bot")) return new Response(new Uint8Array(8_000));
  const method = String(input).split("/").at(-1) ?? "";
  const body = init?.body ? (JSON.parse(await new Response(init.body).text()) as Record<string, unknown>) : {};
  if (method === "setWebhook" && typeof body.url === "string") webhookUrl = body.url;
  const result =
    method === "getMe"
      ? { id: 100000001, is_bot: true, first_name: "Zuri", username: "zuri_local_bot" }
      : method === "getWebhookInfo"
        ? { url: webhookUrl, pending_update_count: 0 }
        : method === "sendMessage"
          ? { message_id: 1 }
          : method === "getFile"
            ? { file_id: body.file_id, file_size: 8_000, file_path: "voice/file_1.oga" }
            : method === "createForumTopic"
            ? { message_thread_id: 2, name: body.name }
            : true;
  return Response.json({ ok: true, result });
}
