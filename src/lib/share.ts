/** System share sheet and clipboard (invite link, "Kopieer als tekst"). */
import * as Clipboard from 'expo-clipboard';
import { Platform, Share } from 'react-native';

/** "Doe je boodschappen samen met mij in Goedboodschap: <url> · Code: <code>" (design-spec 4.2). */
export function inviteMessage(url: string, code: string): string {
  return `Doe je boodschappen samen met mij in Goedboodschap: ${url} · Code: ${code}`;
}

export type ShareOutcome = 'shared' | 'dismissed' | 'copied' | 'failed';

/** Opens the system share sheet; where there is none (web), copies the text instead. */
export async function shareText(message: string): Promise<ShareOutcome> {
  const nav = (globalThis as { navigator?: { share?: (d: { text: string }) => Promise<void> } }).navigator;
  if (Platform.OS === 'web' && !nav?.share) return (await copyText(message)) ? 'copied' : 'failed';
  try {
    const r = await Share.share({ message });
    return r.action === Share.dismissedAction ? 'dismissed' : 'shared';
  } catch {
    return (await copyText(message)) ? 'copied' : 'failed';
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}
