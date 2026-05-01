import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";

export const telegramOutboundBaseAdapter = {
  deliveryMode: "gateway" as const,
  chunker: chunkMarkdownText,
  chunkerMode: "markdown" as const,
  extractMarkdownImages: true,
  textChunkLimit: 4000,
  pollMaxOptions: 10,
};
