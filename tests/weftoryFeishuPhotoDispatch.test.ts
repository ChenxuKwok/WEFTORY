import { afterEach, expect, test, vi } from 'vitest';

import plugin from '../openclaw-extensions/weftory-fashion/index';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('forwards an inbound private photo and leaves unrelated messages alone', async () => {
  vi.stubEnv('OPENCLAW_STATE_DIR', '/tmp/weftory');
  const on = vi.fn();
  plugin.register({
    on,
    pluginConfig: { callbackUrl: 'http://127.0.0.1:12345/weftory-command', secret: 'fixture' },
  } as unknown as Parameters<typeof plugin.register>[0]);
  const handler = on.mock.calls[0][1];
  const send = vi.fn(async () => Response.json({ text: 'Queued' }));
  vi.stubGlobal('fetch', send);
  const filename = 'coat---e6d93ecc-8808-4de8-b545-d3bdab2d5196.jpg';
  const body = `/tmp/weftory/media/inbound/${filename}`;
  const context = { channelId: 'feishu', accountId: 'account', conversationId: 'chat', senderId: 'ou_owner', messageId: 'om_photo' };
  expect(await handler({ content: body, isGroup: true }, context)).toBeUndefined();
  expect(await handler({ content: `/another/directory/${filename}`, isGroup: false }, context)).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  expect(await handler({ content: body, isGroup: false }, context)).toEqual({ handled: true, text: 'Queued' });
  expect(send).toHaveBeenCalledExactlyOnceWith(
    'http://127.0.0.1:12345/weftory-command',
    expect.objectContaining({ body: JSON.stringify({ imageFile: filename, senderId: 'ou_owner',
      messageId: 'om_photo', accountId: 'account', conversationId: 'chat' }) }),
  );
  send.mockClear();
  expect(await handler({ content: '![image](img_v3_fixture-key)', isGroup: false }, context))
    .toEqual({ handled: true, text: 'Queued' });
  expect(send).toHaveBeenCalledExactlyOnceWith(
    'http://127.0.0.1:12345/weftory-command',
    expect.objectContaining({ body: JSON.stringify({ imageUnavailable: true, senderId: 'ou_owner',
      messageId: 'om_photo', accountId: 'account', conversationId: 'chat' }) }),
  );
});

test('routes Feishu card form values through the authenticated bridge', async () => {
  const registerInteractiveHandler = vi.fn();
  plugin.register({
    on: vi.fn(), registerInteractiveHandler,
    pluginConfig: { callbackUrl: 'http://127.0.0.1:12345/weftory-command', secret: 'fixture' },
  } as unknown as Parameters<typeof plugin.register>[0]);
  const registration = registerInteractiveHandler.mock.calls[0][0];
  const send = vi.fn(async () => Response.json({ text: 'Drafting' }));
  vi.stubGlobal('fetch', send);
  const draftId = 'e6d93ecc-8808-4de8-b545-d3bdab2d5196';
  expect(registration.namespace).toBe('weftory-video');
  expect(await registration.handler({
    payload: `draft:${draftId}:2`, accountId: 'account', conversationId: 'oc_chat',
    senderId: 'ou_owner', messageId: 'om_card',
    rawEvent: { action: { form_value: { model: 'Studio styling', script: 'Close-up' } } },
  })).toEqual({ toast: { type: 'info', content: 'Drafting' } });
  expect(send).toHaveBeenCalledExactlyOnceWith(
    'http://127.0.0.1:12345/weftory-command',
    expect.objectContaining({ body: JSON.stringify({
      senderId: 'ou_owner', messageId: 'om_card', accountId: 'account', conversationId: 'oc_chat',
      card: { action: 'draft', draftId, revision: 2, model: 'Studio styling', script: 'Close-up' },
    }) }),
  );
});
