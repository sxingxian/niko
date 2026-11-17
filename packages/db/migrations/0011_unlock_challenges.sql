-- Passkey challenges for unlocking the screen lock: a third kind beside signing up a passkey and signing in.
alter table webauthn_challenges drop constraint if exists webauthn_challenges_kind_check;
alter table webauthn_challenges add constraint webauthn_challenges_kind_check check (kind in ('register', 'login', 'unlock'));
