import type { ToolDef } from 'cortico/core/types.ts';

const make = (
  name: string,
  description: string,
  tags: ToolDef['tags'],
  properties: Record<string, unknown>,
  required: string[] = [],
): Omit<ToolDef, 'handler'> => ({
  name,
  description,
  tags,
  parameters: { type: 'object', additionalProperties: false, properties, required },
});

export const FEISHU_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  make(
    'feishu_status',
    'Read whether the Feishu long connection is up, which account it is, today’s reply count and the last error. Does not send anything.',
    ['read', 'snapshot'],
    {},
  ),
  make(
    'feishu_reply',
    'Send a reply on Feishu: plain text, an image (by log:/mem: blob handle), and/or an emoji reaction on a received message. Pass messageId to reply/react to a message already received, or chatId to send into a chat that has already sent a message here. At least one of text, image or reaction is required. Refuses unknown chats, non-owner direct messages when an owner is set, file paths in image, and texts that contain an open_id or chatId unless the chat is a known direct message.',
    ['speak'],
    {
      text: {
        type: 'string',
        minLength: 1,
        maxLength: 3000,
        description: 'Message text, plain text. Optional when image or reaction is provided.',
      },
      image: {
        type: 'string',
        description: 'Optional image blob handle from the host (must start with "mem:" or "log:"; local file paths and URLs are refused).',
      },
      reaction: {
        type: 'string',
        description: 'Optional Feishu emoji_type to add as a reaction on messageId (e.g. THUMBSUP, OK, DONE, HEART, SMILE, LAUGH, THINKING, CLAP, FIRE, PARTY, PRAY, MUSCLE). Requires messageId.',
      },
      chatId: { type: 'string', description: 'Target chat id (from the message event meta).' },
      messageId: {
        type: 'string',
        description: 'Reply or react to this message id instead of sending a new one; takes precedence over chatId.',
      },
    },
    [],
  ),
  make(
    'feishu_roster',
    'List who is in a Feishu chat by chatId: each member’s open_id and display name (names are cached). Read-only; needs the contact and group-member permissions.',
    ['read', 'snapshot'],
    {
      chatId: { type: 'string', description: 'Chat id from a message event meta, e.g. oc_…' },
    },
    ['chatId'],
  ),
  make(
    'feishu_setup',
    'Store the Feishu app credentials (App ID / App Secret) as secrets and reconnect. The secret is saved, not echoed back. Use once, or after the app is recreated.',
    ['write'],
    {
      appId: { type: 'string', maxLength: 200 },
      appSecret: { type: 'string', maxLength: 400 },
    },
    ['appId', 'appSecret'],
  ),
];
