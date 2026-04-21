import { beforeEach, describe, expect, it, vi } from "vitest";
import { textResult, type AnyAgentTool } from "./tools/common.js";

function stubTool(name: string): AnyAgentTool {
  return {
    label: name,
    name,
    description: `${name} stub`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return textResult("ok", {});
    },
  };
}

const imageTool = stubTool("image");
const pdfTool = stubTool("pdf");
const imageGenerateTool = stubTool("image_generate");
const musicGenerateTool = stubTool("music_generate");
const videoGenerateTool = stubTool("video_generate");

const createImageToolMock = vi.fn();
const createPdfToolMock = vi.fn();
const createImageGenerateToolMock = vi.fn();
const createMusicGenerateToolMock = vi.fn();
const createVideoGenerateToolMock = vi.fn();

vi.mock("./tools/image-tool.js", () => ({ createImageTool: createImageToolMock }));
vi.mock("./tools/pdf-tool.js", () => ({ createPdfTool: createPdfToolMock }));
vi.mock("./tools/image-generate-tool.js", () => ({
  createImageGenerateTool: createImageGenerateToolMock,
}));
vi.mock("./tools/music-generate-tool.js", () => ({
  createMusicGenerateTool: createMusicGenerateToolMock,
}));
vi.mock("./tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: createVideoGenerateToolMock,
}));

beforeEach(() => {
  createImageToolMock.mockReset().mockReturnValue(imageTool);
  createPdfToolMock.mockReset().mockReturnValue(pdfTool);
  createImageGenerateToolMock.mockReset().mockReturnValue(imageGenerateTool);
  createMusicGenerateToolMock.mockReset().mockReturnValue(musicGenerateTool);
  createVideoGenerateToolMock.mockReset().mockReturnValue(videoGenerateTool);
});

describe("createOpenClawMediaTools", () => {
  it("registers the dedicated media tool lane in the existing order", async () => {
    const { createOpenClawMediaTools } = await import("./openclaw-media-tools.js");
    expect(createOpenClawMediaTools().map((tool) => tool.name)).toEqual([
      "image_generate",
      "music_generate",
      "video_generate",
    ]);
    expect(createImageToolMock).not.toHaveBeenCalled();
    expect(createPdfToolMock).not.toHaveBeenCalled();
  });

  it("adds image and pdf when agentDir is available", async () => {
    const { createOpenClawMediaTools } = await import("./openclaw-media-tools.js");
    expect(
      createOpenClawMediaTools({ agentDir: "/tmp/openclaw-media-tools" }).map((tool) => tool.name),
    ).toEqual(["image_generate", "music_generate", "video_generate", "image", "pdf"]);
  });

  it("keeps the omnibus composer exposing the same media tool block", async () => {
    const { createOpenClawTools } = await import("./openclaw-tools.js");
    const allNames = createOpenClawTools({
      agentDir: "/tmp/openclaw-media-tools",
      disablePluginTools: true,
    }).map((tool) => tool.name);
    expect(
      allNames.filter((name) =>
        ["image_generate", "music_generate", "video_generate", "image", "pdf"].includes(name),
      ),
    ).toEqual(["image_generate", "music_generate", "video_generate", "image", "pdf"]);
  });
});
