/** Mail from any provider that offers IMAP (Gmail, iCloud, Yahoo, Fastmail…): unread messages in the inbox, read-only. */
import { ImapFlow } from 'imapflow';
import type { Mail } from '../shared/types';

export type MailLogin = { id: string; host: string; port: number; user: string; pass: string };

export const MAIL_PRESETS: Record<string, { name: string; host: string; port: number; help: string }> = {
  gmail: { name: 'Gmail', host: 'imap.gmail.com', port: 993, help: 'Use an app password, not your normal one: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords.' },
  icloud: { name: 'iCloud', host: 'imap.mail.me.com', port: 993, help: 'Use an app-specific password from account.apple.com → Sign-In and Security.' },
  yahoo: { name: 'Yahoo', host: 'imap.mail.yahoo.com', port: 993, help: 'Use an app password from Yahoo Account Security.' },
  fastmail: { name: 'Fastmail', host: 'imap.fastmail.com', port: 993, help: 'Use an app password from Settings → Privacy & Security.' },
  other: { name: 'Other', host: '', port: 993, help: 'Enter your provider\'s IMAP server. Outlook.com and Hotmail are not supported: Microsoft only allows sign-in through its own apps.' },
};

/** Where to open a message: Gmail's own page for that conversation, picking the right Google account. */
export function mailLink(acc: { host: string; user: string }, threadId?: string, messageId?: string): string | undefined {
  if (!/gmail|googlemail/i.test(acc.host)) return undefined;
  const base = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(acc.user)}`;
  try {
    // Gmail's web addresses use the conversation number in hexadecimal.
    if (threadId && /^\d+$/.test(threadId)) return `${base}#all/${BigInt(threadId).toString(16)}`;
  } catch {
    /* fall through to a search for the message */
  }
  return messageId ? `${base}#search/${encodeURIComponent(`rfc822msgid:${messageId.replace(/^<|>$/g, '')}`)}` : `${base}#inbox`;
}

/** Unread messages in the inbox, newest first. Opens the mailbox read-only: nothing is marked as read or changed. */
export async function fetchUnread(acc: MailLogin, limit = 8): Promise<{ unread: number; items: Mail[] }> {
  const client = new ImapFlow({
    host: acc.host, port: acc.port, secure: acc.port === 993, auth: { user: acc.user, pass: acc.pass }, logger: false,
    disableAutoIdle: true, socketTimeout: 20000, greetingTimeout: 12000, connectionTimeout: 12000,
  } as never);
  // Without this, a dropped connection would crash the whole app.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    const e = err as { authenticationFailed?: boolean; code?: string; message: string; response?: string; responseText?: string; serverResponseCode?: string };
    const said = `${e.responseText ?? ''} ${e.response ?? ''}`.replace(/\s+/g, ' ').trim();
    if (/application-specific password required/i.test(said)) throw new Error('Google wants an app password here, not your normal Google password. Create one at myaccount.google.com/apppasswords (2-Step Verification must be on) and paste the 16 letters it gives you');
    if (e.authenticationFailed || /AUTHENTICATIONFAILED|invalid credentials/i.test(said)) throw new Error(`the mail server refused the password${/gmail|google/i.test(acc.host) ? '. For Gmail this must be a 16-letter app password from myaccount.google.com/apppasswords, typed without mistakes; your normal Google password will not work' : ' (most providers need an app password)'}${said ? ` [server said: ${said.slice(0, 140)}]` : ''}`);
    throw new Error(/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|EHOSTUNREACH/i.test(`${e.code} ${e.message}`) ? `can't reach ${acc.host} (check the internet connection)` : `${e.message}${said ? ` [server said: ${said.slice(0, 140)}]` : ''}`);
  }
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const found = await client.search({ seen: false }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => a - b);
      const items: Mail[] = [];
      if (uids.length) {
        const gmail = /gmail|googlemail/i.test(acc.host);
        for await (const msg of client.fetch(uids.slice(-limit), { envelope: true, uid: true, internalDate: true, ...(gmail ? { threadId: true } : {}) }, { uid: true })) {
          const from = msg.envelope?.from?.[0];
          items.push({
            id: `${acc.id}:${msg.uid}`, from: from?.name || (from?.address ? from.address.split('@')[0].replace(/[._]+/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) : 'Unknown'), subject: msg.envelope?.subject || '(no subject)',
            at: new Date(msg.envelope?.date ?? msg.internalDate ?? Date.now()).getTime(),
            link: mailLink(acc, (msg as { threadId?: string }).threadId, msg.envelope?.messageId),
          });
        }
      }
      return { unread: uids.length, items: items.sort((a, b) => b.at - a.at) };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}
