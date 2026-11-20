# Manager.io Webhooks

A community-developed script that brings webhook notifications to [Manager.io](https://www.manager.io/).

Manager.io does not natively provide webhook notifications for record changes. This script provides a lightweight workaround by detecting successful operations performed through the browser interface and forwarding events to any webhook endpoint.

Connect Manager.io to **n8n, Make, Zapier, or your own applications** without modifying Manager.io's source code.

## Features

- **Create events** – Detect newly created records.
- **Update events** – Detect modified records.
- **Delete events** – Detect deleted records.
- **Universal record detection** – Supports different Manager.io record types.
- **Custom webhook endpoint** – Send events to any webhook-compatible application.
- **Automatic retry** – Failed deliveries are queued locally and retried.
- **Duplicate identification** – Every event includes a unique event ID.
- **Lightweight payload** – Sends record identifiers and event metadata, not complete record contents.

## Installation

1. Open your Manager.io business.
2. Navigate to **Settings → Custom Themes / Legacy Browser Extensions** (depending on your Manager.io version).
3. Create a new browser extension.
4. Paste the contents of the JavaScript file into the extension editor.
5. Select **Run Everywhere** as the execution scope.
6. Replace the webhook URL in the script with your own endpoint:

   ```javascript
   var WEBHOOK_URL = 'https://your-webhook-url-here';
   ```

7. Save the extension.

That's it! The script will now monitor supported browser operations and send events to your configured webhook.

## Webhook Payload

Each successful operation generates a JSON payload similar to:

```json
{
  "entity_type": "sales_invoice",
  "action": "create",
  "guid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "http_method": "POST",
  "source": "UI",
  "timestamp": "2026-11-20T10:00:00.000Z",
  "event_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

### Supported actions

- `create`
- `update`
- `delete`

### Data and privacy

The script intentionally sends minimal information.

It does **not** transmit:
- Customer or supplier names.
- Invoice amounts or balances.
- Invoice line items.
- Cookies or authentication tokens.
- Complete record contents.

It only sends the record type, action, GUID, and event metadata.

The GUID is an internal Manager.io record identifier and can be used by your receiving application to retrieve the corresponding record through the Manager.io API.

## Important limitations

- Only detects operations performed through a browser where the extension is installed.
- Does not detect API operations, imports, or changes made by other applications.
- Requires a reachable webhook endpoint.
- Delivery uses a local browser queue, so pending events depend on the browser's local storage remaining available.
- The receiving application should implement event deduplication using `event_id`.

## Security

- Replace the example webhook URL with your own endpoint.
- Never publish private webhook URLs or authentication credentials.
- The webhook endpoint should implement its own validation and security controls.
- Anyone with access to Manager.io who can inspect the extension can see its configured webhook URL.

## Disclaimer

This is an unofficial, community-developed script. It is not affiliated with or endorsed by Manager.io.

Use it at your own discretion. Test it in a non-production environment before relying on it for business-critical automation.

## Contributions

Suggestions, improvements, bug reports, and pull requests are welcome!

If you improve the script or add support for additional Manager.io operations, feel free to contribute.

---

**Built to make Manager.io more connected.**
