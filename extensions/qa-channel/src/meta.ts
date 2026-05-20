import { getChatChannelMeta } from "./runtime-api.js";
import type { ChannelPlugin } from "./runtime-api.js";

export const QA_CHANNEL_ID = "qa-channel" as const;

const fallbackMeta: ChannelPlugin["meta"] = {
  id: QA_CHANNEL_ID,
  label: "QA Channel",
  selectionLabel: "QA Channel (Synthetic)",
  detailLabel: "QA Channel",
  docsPath: "/channels/qa-channel",
  docsLabel: "qa-channel",
  blurb: "Synthetic Slack-class transport for automated OpenClaw QA scenarios.",
  systemImage: "checklist",
  order: 999,
  exposure: {
    configured: false,
    setup: false,
    docs: false,
  },
};

export function getQaChannelMeta(): ChannelPlugin["meta"] {
  const catalogMeta = getChatChannelMeta(QA_CHANNEL_ID) as
    | Partial<ChannelPlugin["meta"]>
    | undefined;
  return {
    ...fallbackMeta,
    ...catalogMeta,
    id: QA_CHANNEL_ID,
    label: catalogMeta?.label ?? fallbackMeta.label,
    selectionLabel: catalogMeta?.selectionLabel ?? fallbackMeta.selectionLabel,
    docsPath: catalogMeta?.docsPath ?? fallbackMeta.docsPath,
    blurb: catalogMeta?.blurb ?? fallbackMeta.blurb,
  };
}
