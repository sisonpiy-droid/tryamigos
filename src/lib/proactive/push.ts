import webpush from "web-push";

/* Web Push, the only way to reach someone whose browser tab is closed.
 *
 * The VAPID keys identify this server to the browsers' push services; the
 * private one never leaves it. Without them configured, outreach still
 * happens -- it waits in the app and appears the next time MUSE is opened --
 * it just cannot buzz a phone.
 */

let configured: boolean | null = null;

function ready(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return (configured = false);
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:muse@example.com", pub, priv);
  return (configured = true);
}

export const pushPublicKey = (): string | null => process.env.VAPID_PUBLIC_KEY || null;

export type PushResult = "sent" | "gone" | "failed" | "unconfigured";

export async function push(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: { title: string; body: string; url: string; tag: string; interactionId: string }
): Promise<PushResult> {
  if (!ready()) return "unconfigured";
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      /* Six hours: a nudge about this evening is pointless tomorrow. */
      { TTL: 6 * 3600, urgency: "normal", topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) }
    );
    return "sent";
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    /* The subscription no longer exists (uninstalled, permission revoked). */
    if (status === 404 || status === 410) return "gone";
    console.error("push failed", status ?? err);
    return "failed";
  }
}
