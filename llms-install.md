# Installing the Aevum MCP server (for AI agents like Cline)

Aevum is a **hosted, remote** MCP server. There is nothing to clone, build or install, and it needs **no API key and no sign-up**.

## Steps

1. Add this entry to the MCP settings file (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "aevum": {
      "type": "streamableHttp",
      "url": "https://app.aevumprotocol.io/mcp",
      "disabled": false
    }
  }
}
```

   If the client does not accept `streamableHttp`, use `"type": "http"` (same URL).

2. Save the file. The server should connect and list 14 tools (`get_record`, `check_polymarket_wallet`, `check_hyperliquid_wallet`, `check_payout_wallet`, `get_certificate`, `recheck_certificate`, `draft_call`, ...).

3. Test it with `how_aevum_works` (no arguments), or `check_polymarket_wallet` with any Polymarket wallet address.

## Notes

- All read tools are free and need no credentials.
- `draft_call` returns a link where the person locks the call in **their own wallet** on app.aevumprotocol.io. The agent never handles keys or signs anything.
- Results describe past calls and are not investment advice.
