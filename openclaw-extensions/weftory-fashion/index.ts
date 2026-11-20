import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

export default {
  id: 'weftory-fashion',
  name: 'WEFTORY Feishu Commands',
  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig;
    const callbackUrl = typeof config?.callbackUrl === 'string' ? config.callbackUrl : '';
    const secret = typeof config?.secret === 'string' ? config.secret : '';
    if (!/^http:\/\/127\.0\.0\.1:\d+\/weftory-command$/.test(callbackUrl) || !secret) return;
    api.on('before_dispatch', async (event, context) => {
      const channel = context.channelId || event.channel;
      const command = event.content.trim();
      if (channel !== 'feishu' || !/^\/wft(?:\s|$)/.test(command)) return;
      const senderId = (context.senderId || event.senderId)?.replace(/^feishu:/, '');
      const messageId = context.messageId || event.messageId;
      if (event.isGroup !== false || !senderId || !context.accountId || !messageId || !context.conversationId) {
        return { handled: true, text: 'WEFTORY: unauthorized conversation / 会话未授权' };
      }
      try {
        const response = await fetch(callbackUrl, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
          headers: { 'Content-Type': 'application/json', 'x-mcp-bridge-secret': secret },
          body: JSON.stringify({ command, senderId, messageId,
            accountId: context.accountId, conversationId: context.conversationId }),
        });
        const data = response.ok ? await response.json() as { text?: string } : null;
        if (typeof data?.text === 'string') return { handled: true, text: data.text };
      } catch {
        // The host can be shutting down. The command must not fall through to the model.
      }
      return { handled: true, text: 'WEFTORY: desktop unavailable / 桌面应用不可用' };
    });
  },
};
