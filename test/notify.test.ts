import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { alertsConfigured, detectChatId, notify, tag } from '../src/runner/notify.js';

describe('telegram alerts', () => {
  beforeEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });

  it('is off, and makes no network call, without both settings', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(alertsConfigured()).toBe(false);
    expect(await notify('hello')).toBe(false);
    process.env.TELEGRAM_BOT_TOKEN = 'tok'; // token alone is not enough
    expect(alertsConfigured()).toBe(false);
    expect(await notify('hello')).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('posts to the bot API when configured', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_CHAT_ID = '42';
    const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await notify('level 2 reached')).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottok/sendMessage');
    expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: '42', text: 'level 2 reached' });
  });

  it('never throws when Telegram is down: an alert must not break a cycle', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_CHAT_ID = '42';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(notify('boom')).resolves.toBe(false);
  });

  it('labels simulated runs so they cannot be mistaken for real ones', () => {
    expect(tag('paper')).toBe('[SIMULATED]');
    expect(tag('kraken')).toBe('[LIVE KRAKEN]');
  });

  describe('detectChatId (Telegram onboarding)', () => {
    it('asks for the token first when none is saved', async () => {
      await expect(detectChatId()).rejects.toThrow(/Save the bot token first/);
    });

    it('reports a rejected token in plain words', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'bad';
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })));
      await expect(detectChatId()).rejects.toThrow(/rejected the bot token \(Unauthorized\)/);
    });

    it('finds the most recent chat and returns its name', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      const updates = {
        ok: true,
        result: [
          { update_id: 1, message: { chat: { id: 111, first_name: 'Old' } } },
          { update_id: 2, message: { chat: { id: 424242, first_name: 'Simon' } } },
        ],
      };
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        expect(String(url)).toBe('https://api.telegram.org/bottok/getUpdates');
        return new Response(JSON.stringify(updates), { status: 200 });
      }));
      await expect(detectChatId()).resolves.toEqual({ chatId: '424242', name: 'Simon' });
    });

    it('tells the user to message the bot when no update exists yet', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'tok';
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })));
      await expect(detectChatId()).rejects.toThrow(/press Start or send it any message/);
    });
  });
});
