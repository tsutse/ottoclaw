import { Hono } from 'hono';
import type { Sandbox } from '@cloudflare/sandbox';
import type { AppEnv } from '../types';
import { ensureMoltbotGateway } from '../gateway';
import { MOLTBOT_PORT } from '../config';

const hooks = new Hono<AppEnv>();

/**
 * POST /hooks/whatsapp?token=<WHATSAPP_HOOK_TOKEN>
 *
 * Receives WhatsApp messages from WaSender API and injects them into the
 * OpenClaw agent via its WebSocket gateway.
 *
 * This route intentionally sits outside Cloudflare Access — it uses its own
 * token (WHATSAPP_HOOK_TOKEN) so that WaSender can call it without custom headers.
 */
hooks.post('/whatsapp', async (c) => {
  // --- Token validation ---
  const token = c.req.query('token');
  if (!c.env.WHATSAPP_HOOK_TOKEN) {
    console.error('[HOOKS/WA] WHATSAPP_HOOK_TOKEN is not configured');
    return c.json({ error: 'Webhook not configured' }, 503);
  }
  if (!token || token !== c.env.WHATSAPP_HOOK_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // --- Parse WaSender payload ---
  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const messageText = extractMessageText(payload);
  if (!messageText) {
    // Not a text message we can handle — ack and ignore
    return c.json({ ok: true, skipped: true });
  }

  console.log('[HOOKS/WA] Received message:', messageText.slice(0, 100));

  // --- Ensure gateway is running ---
  const sandbox = c.get('sandbox');
  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[HOOKS/WA] Gateway not ready:', error);
    return c.json({ error: 'Gateway not ready' }, 503);
  }

  // --- Inject message asynchronously (fire and forget) ---
  // WaSender expects a quick 200. We do the actual injection in the background.
  c.executionCtx.waitUntil(
    injectMessage(sandbox, c.env.MOLTBOT_GATEWAY_TOKEN, messageText).catch((err) => {
      console.error('[HOOKS/WA] Message injection failed:', err);
    }),
  );

  return c.json({ ok: true });
});

/**
 * Extract a plain-text message from a WaSender webhook payload.
 * Returns null for non-text events (images, status updates, etc.).
 */
function extractMessageText(payload: Record<string, unknown>): string | null {
  const data = payload.data as Record<string, unknown> | undefined;
  if (!data) return null;

  const from = (data.from as string) || 'unknown';
  const pushName = (data.pushName as string) || '';
  const senderLabel = pushName ? `${pushName} (${from})` : from;

  // Nested message object (WaSender format)
  const msg = data.message as Record<string, unknown> | undefined;
  if (msg) {
    const text =
      (msg.text as string) ||
      (msg.conversation as string) ||
      (msg.caption as string) ||
      null;
    if (text) return `[WhatsApp from ${senderLabel}]: ${text}`;
  }

  // Flat text field
  const flatText = data.text as string | undefined;
  if (flatText) return `[WhatsApp from ${senderLabel}]: ${flatText}`;

  return null;
}

/**
 * Connect to the OpenClaw gateway WebSocket and send a message.
 *
 * The gateway uses a JSON-RPC-style protocol:
 *   1. Send a "connect" frame to establish the session
 *   2. Wait for the connect response
 *   3. Send a "sendMessage" frame with the text
 *   4. Close the connection
 */
async function injectMessage(
  sandbox: Sandbox,
  gatewayToken: string | undefined,
  messageText: string,
): Promise<void> {
  const tokenParam = gatewayToken ? `?token=${encodeURIComponent(gatewayToken)}` : '';

  // Create a synthetic WebSocket upgrade request pointing at the gateway
  const wsRequest = new Request(`http://localhost:${MOLTBOT_PORT}/${tokenParam}`, {
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': btoa('whatsapp-hook-key-16b'),
      'Sec-WebSocket-Version': '13',
      Host: 'localhost',
    },
  });

  const response = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
  const ws = response.webSocket;

  if (!ws) {
    throw new Error('[HOOKS/WA] No WebSocket returned from sandbox.wsConnect');
  }

  ws.accept();

  await new Promise<void>((resolve) => {
    let messageSent = false;

    // Safety timeout — always resolve so the waitUntil doesn't hang
    const timeout = setTimeout(() => {
      console.warn('[HOOKS/WA] WebSocket timeout — closing');
      try {
        ws.close(1000, 'timeout');
      } catch {}
      resolve();
    }, 10_000);

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;

        // After successful connect response, send the user message
        if (!messageSent && msg['method'] === 'connect') {
          messageSent = true;
          ws.send(
            JSON.stringify({
              type: 'req',
              id: `wa-msg-${Date.now()}`,
              method: 'sendMessage',
              params: { text: messageText },
            }),
          );

          // Give the agent a moment to queue the message, then close
          setTimeout(() => {
            try {
              ws.close(1000, 'done');
            } catch {}
            clearTimeout(timeout);
            resolve();
          }, 2_000);
        }
      } catch {
        // Ignore parse errors from non-JSON frames
      }
    });

    ws.addEventListener('close', () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.addEventListener('error', (event) => {
      console.error('[HOOKS/WA] WebSocket error:', event);
      clearTimeout(timeout);
      resolve();
    });

    // Step 1: Send the connect frame (format from debug/ws-test page)
    ws.send(
      JSON.stringify({
        type: 'req',
        id: `wa-connect-${Date.now()}`,
        method: 'connect',
        params: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: 'whatsapp-hook',
            displayName: 'WhatsApp',
            version: '1.0.0',
            mode: 'webchat',
            platform: 'web',
          },
          role: 'operator',
          scopes: [],
        },
      }),
    );
  });
}

export { hooks };
