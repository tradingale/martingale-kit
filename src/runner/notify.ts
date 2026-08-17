// Optional Telegram alerts, so a runner left on a box can tell you what it
// did while you were away. Zero dependencies: one fetch to the Bot API.
//
// SAFETY RULES, both deliberate:
//  1. Alerts are FIRE AND FORGET and never throw. A notification failure
//     must never break a reconciliation cycle: the orders matter, the
//     message does not.
//  2. Alerts are OFF unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are
//     both set. No token, no network call, no noise.
//
// Wording stays descriptive (what happened, on which sequence), never
// advice, and simulated runs say so.

const API = 'https://api.telegram.org';

export function alertsConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/**
 * Send a Telegram message. Resolves to true when Telegram accepted it,
 * false in every other case (not configured, network down, API error).
 * Never rejects.
 */
export async function notify(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Prefix every alert so a simulated run can never be mistaken for a real one. */
export function tag(venue: string): string {
  return venue === 'paper' ? '[SIMULATED]' : `[LIVE ${venue.toUpperCase()}]`;
}

export interface DetectedChat {
  chatId: string;
  /** First name / title of the chat, for "is this really me?" confirmation. */
  name: string;
}

/**
 * Find the chat id for the configured bot token by reading the bot's recent
 * updates: the user talks to their bot once, we look at who talked. Throws
 * with instructions (not codes) when something is missing — these messages
 * are shown verbatim in the Keys page.
 */
export async function detectChatId(): Promise<DetectedChat> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Save the bot token first (step 1), then try again.');
  let payload: {
    ok?: boolean;
    description?: string;
    result?: Array<{
      update_id: number;
      message?: { chat?: { id?: number; first_name?: string; title?: string; username?: string } };
      channel_post?: { chat?: { id?: number; first_name?: string; title?: string; username?: string } };
    }>;
  };
  try {
    const res = await fetch(`${API}/bot${token}/getUpdates`);
    payload = (await res.json()) as typeof payload;
  } catch {
    throw new Error('Could not reach the Telegram API from this server. Check the network and try again.');
  }
  if (!payload.ok) {
    throw new Error(
      `Telegram rejected the bot token${payload.description ? ` (${payload.description})` : ''}. Re-copy it from @BotFather and save it again.`,
    );
  }
  const updates = payload.result ?? [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i].message?.chat ?? updates[i].channel_post?.chat;
    if (chat?.id !== undefined) {
      return {
        chatId: String(chat.id),
        name: chat.first_name ?? chat.title ?? chat.username ?? 'unknown',
      };
    }
  }
  throw new Error(
    'No message found yet. Open your bot in Telegram (t.me/YOUR_BOT_NAME), press Start or send it any message, then click Detect again.',
  );
}
