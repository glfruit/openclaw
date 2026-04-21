import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { collectPresentOpenClawTools } from "./openclaw-tools.registration.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMusicGenerateTool } from "./tools/music-generate-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createVideoGenerateTool } from "./tools/video-generate-tool.js";

export type OpenClawMediaToolsOptions = {
  config?: OpenClawConfig;
  agentDir?: string;
  agentSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
  fsPolicy?: ToolFsPolicy;
  modelHasVision?: boolean;
};

export function createOpenClawMediaTools(options?: OpenClawMediaToolsOptions): AnyAgentTool[] {
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        workspaceDir: options?.workspaceDir,
        sandbox: options?.sandbox,
        fsPolicy: options?.fsPolicy,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const imageGenerateTool = createImageGenerateTool({
    config: options?.config,
    agentDir: options?.agentDir,
    workspaceDir: options?.workspaceDir,
    sandbox: options?.sandbox,
    fsPolicy: options?.fsPolicy,
  });
  const videoGenerateTool = createVideoGenerateTool({
    config: options?.config,
    agentDir: options?.agentDir,
    agentSessionKey: options?.agentSessionKey,
    requesterOrigin: options?.requesterOrigin,
    workspaceDir: options?.workspaceDir,
    sandbox: options?.sandbox,
    fsPolicy: options?.fsPolicy,
  });
  const musicGenerateTool = createMusicGenerateTool({
    config: options?.config,
    agentDir: options?.agentDir,
    agentSessionKey: options?.agentSessionKey,
    requesterOrigin: options?.requesterOrigin,
    workspaceDir: options?.workspaceDir,
    sandbox: options?.sandbox,
    fsPolicy: options?.fsPolicy,
  });
  const pdfTool = options?.agentDir?.trim()
    ? createPdfTool({
        config: options?.config,
        agentDir: options.agentDir,
        workspaceDir: options?.workspaceDir,
        sandbox: options?.sandbox,
        fsPolicy: options?.fsPolicy,
      })
    : null;

  return collectPresentOpenClawTools([
    imageGenerateTool,
    musicGenerateTool,
    videoGenerateTool,
    imageTool,
    pdfTool,
  ]);
}
