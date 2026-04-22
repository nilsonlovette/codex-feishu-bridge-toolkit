# Setup Reference

## Inputs To Collect

- Path to the user's bridge-compatible local implementation.
- Feishu app ID.
- Feishu app secret.
- One or more allowed Feishu open IDs.
- Default open ID for assistant replies.

Do not ask the user to paste secrets into public files. Use local configuration only.

## Bootstrap

```powershell
.\scripts\install.ps1 -BridgeSourcePath "D:\path\to\your\bridge"
```

This creates a local config directory under `%LOCALAPPDATA%\Codex\FeishuBridge` and copies `templates\bridge-config.example.json` to `bridge-config.json` if missing.

## Configure

```powershell
.\scripts\configure.ps1 -AppId "cli_xxx" -AppSecret "<your-secret>" -AllowlistOpenIds @("ou_xxx") -DefaultOpenId "ou_xxx" -Enable
```

The script refuses to enable the bridge with placeholder values.

## Validate

```powershell
.\scripts\doctor.ps1 -BridgeSourcePath "D:\path\to\your\bridge" -CheckPipe
```

Fix failing checks before sending live messages.

