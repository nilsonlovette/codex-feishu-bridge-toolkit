# Feishu App Setup

Use a Feishu custom app dedicated to this bridge. Start with one test user and one private chat before expanding scope.

## Required Values

- App ID: placeholder format `cli_xxx`.
- App Secret: keep local only.
- Bot open ID allowlist: placeholder format `ou_xxx`.
- Default open ID: the primary recipient for outbound assistant cards.

## Suggested Permissions

The exact Feishu console labels may change. Select the minimum permissions that allow:

- Receiving bot/private chat messages.
- Sending messages as the bot.
- Creating and updating interactive cards.
- Reading sender identity needed for allowlist checks.

## Setup Steps

1. Create the app in Feishu developer console.
2. Enable bot capability.
3. Configure event subscription or long connection according to your bridge implementation.
4. Add the bot to your target chat.
5. Copy app ID and app secret into local config with `scripts/configure.ps1`.
6. Add only trusted open IDs to `allowlistOpenIds`.
7. Run `scripts/doctor.ps1 -CheckPipe` after the bridge starts.

## Safety Notes

- Never commit app secret or real open IDs.
- Do not broaden allowlist until single-user tests pass.
- Keep destructive maintenance disabled unless the bridge has already completed SQLite quick_check and pending checks.

