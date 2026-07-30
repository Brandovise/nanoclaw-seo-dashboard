/**
 * Webex channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createWebexAdapter } from '@bitbasti/chat-adapter-webex';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('webex', {
  factory: () => {
    const env = readEnvFile(['WEBEX_BOT_TOKEN', 'WEBEX_WEBHOOK_SECRET']);
    if (!env.WEBEX_BOT_TOKEN) return null;
    const webexAdapter = createWebexAdapter({
      botToken: env.WEBEX_BOT_TOKEN,
      webhookSecret: env.WEBEX_WEBHOOK_SECRET,
    });
    return createChatSdkBridge({ adapter: webexAdapter, concurrency: 'concurrent', supportsThreads: true });
  },
});
