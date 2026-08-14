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
