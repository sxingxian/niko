// Browser passkey errors in plain words. The raw messages ("An unknown error occurred while talking to the
// credential manager") come from the phone or password manager and say nothing about what to do.
export function passkeyError(x: any, adding: boolean): string {
  const name = String(x?.name ?? '');
  const android = /Android/i.test(navigator.userAgent);
  if (name === 'NotAllowedError' || name === 'AbortError') return adding ? 'Adding the passkey was cancelled or timed out.' : 'Passkey sign-in was cancelled or timed out.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for Niko. Use that one, or remove it in your password manager first.';
  if (name === 'SecurityError') return 'Passkeys do not work on this address. Open Niko from its usual address and try again.';
  if (name === 'NotReadableError' || name === 'UnknownError') {
    return android
      ? 'Your phone’s passkey service did not answer. Check that the phone has a screen lock, and that a password manager is on under Settings → Passwords & accounts (Google Password Manager is the most reliable). If another manager such as Samsung Pass or Bitwarden is chosen, try again and pick Google Password Manager. Then try again.'
      : 'Your device’s passkey service did not answer. Check that a screen lock or Windows Hello is set up, then try again.';
  }
  if (name === 'NotSupportedError') return 'This browser or device cannot make passkeys. Try another browser, or sign in with your password.';
  return x?.message ?? (adding ? 'The passkey could not be added.' : 'Passkey sign-in failed.');
}
