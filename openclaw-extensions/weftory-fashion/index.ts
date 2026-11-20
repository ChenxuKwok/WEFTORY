import path from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

export default {
  id: 'weftory-fashion',
  name: 'WEFTORY Feishu Commands',
  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig;
    const callbackUrl = typeof config?.callbackUrl === 'string' ? config.callbackUrl : '';
    const secret = typeof config?.secret === 'string' ? config.secret : '';
    if (!/^http:\/\/127\.0\.0\.1:\d+\/weftory-command$/.test(callbackUrl) || !secret) return;
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    const inboundDirectory = stateDir ? path.join(stateDir, 'media', 'inbound') : undefined;
    const bridge = async (input: object): Promise<string | undefined> => {
      try {
        const response = await fetch(callbackUrl, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000),
          headers: { 'Content-Type': 'application/json', 'x-mcp-bridge-secret': secret },
          body: JSON.stringify(input),
        });
        const data = response.ok ? await response.json() as { text?: string } : null;
        return typeof data?.text === 'string' ? data.text : undefined;
      } catch {
        return undefined;
      }
    };
    api.registerInteractiveHandler?.({
      channel: 'feishu',
      namespace: 'weftory-video',
      handler: async (raw: unknown) => {
        const context = raw as {
          payload: string; senderId?: string; messageId?: string; accountId?: string; conversationId?: string;
          rawEvent?: { action?: { form_value?: { model?: string; script?: string } } };
        };
        const [action, draftId, revision] = context.payload.split(':');
        const fields = context.rawEvent?.action?.form_value;
        const text = await bridge({
          senderId: context.senderId, messageId: context.messageId, accountId: context.accountId,
          conversationId: context.conversationId,
          card: { action, draftId, revision: Number(revision), model: fields?.model, script: fields?.script },
        });
        return { toast: { type: text ? 'info' : 'error', content: text || 'WEFTORY 桌面应用不可用' } };
      },
    });
    api.on('before_dispatch', async (event, context) => {
      const channel = context.channelId || event.channel;
      if (channel !== 'feishu') return;
      const content = event.content.trim();
      const command = /^\/wft(?:\s|$)/.test(content) ? content
        : /^制作视频[。！!]?$/u.test(content) && event.isGroup === false ? '/wft video' : undefined;
      // The Feishu channel substitutes a downloaded bare image with its local media path.
      const imagePath = !command && event.isGroup === false && inboundDirectory
        ? [content, event.body?.trim()].find(candidate => candidate && path.dirname(candidate) === inboundDirectory
          && /^(?:[\p{L}\p{N}._-]+---)?[\da-f-]{36}\.(?:png|jpe?g)$/iu.test(path.basename(candidate)))
        : undefined;
      const imageFile = imagePath ? path.basename(imagePath) : undefined;
      const imageUnavailable = !command && !imageFile && event.isGroup === false
        && [content, event.body?.trim()].some(value => value && /^!\[image\]\(img_[\w-]+\)$/u.test(value))
        ? true : undefined;
      if (!command && !imageFile && !imageUnavailable) return;
      const senderId = (context.senderId || event.senderId)?.replace(/^feishu:/, '');
      const messageId = context.messageId || event.messageId;
      if (event.isGroup !== false || !senderId || !context.accountId || !messageId || !context.conversationId) {
        return { handled: true, text: 'WEFTORY: unauthorized conversation / 会话未授权' };
      }
      const text = await bridge({ command, imageFile, imageUnavailable, senderId, messageId,
        accountId: context.accountId, conversationId: context.conversationId });
      if (typeof text === 'string') return text || command ? { handled: true, text } : undefined;
      return { handled: true, text: 'WEFTORY: desktop unavailable / 桌面应用不可用' };
    });
  },
};
