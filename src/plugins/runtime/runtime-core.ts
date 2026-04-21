import { resolveStateDir } from "../../config/paths.js";
import {
  generateImage as generateRuntimeImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import {
  generateMusic as generateRuntimeMusic,
  listRuntimeMusicGenerationProviders,
} from "../../music-generation/runtime.js";
import {
  createLazyRuntimeMethod,
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "../../shared/lazy-runtime.js";
import { VERSION } from "../../version.js";
import {
  generateVideo as generateRuntimeVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import { listWebSearchProviders, runWebSearch } from "../../web-search/runtime.js";
import {
  createGatewayBoundSubagentRuntime,
  createPluginChannelRuntime,
} from "./gateway-channel-runtime.js";
import { createRuntimeAgent } from "./runtime-agent.js";
import { defineCachedValue } from "./runtime-cache.js";
import { createRuntimeConfig } from "./runtime-config.js";
import { createRuntimeEvents } from "./runtime-events.js";
import { createRuntimeLogging } from "./runtime-logging.js";
import { createRuntimeSystem } from "./runtime-system.js";
import { createRuntimeTaskFlow } from "./runtime-taskflow.js";
import { createRuntimeTasks } from "./runtime-tasks.js";
import type { CreatePluginRuntimeOptions, PluginRuntime } from "./types.js";

const loadTtsRuntime = createLazyRuntimeModule(() => import("../../tts/tts.js"));
const loadMediaUnderstandingRuntime = createLazyRuntimeModule(
  () => import("../../media-understanding/runtime.js"),
);
const loadModelAuthRuntime = createLazyRuntimeModule(
  () => import("./runtime-model-auth.runtime.js"),
);

export type PluginRuntimeCoreAssembly = Omit<PluginRuntime, "media">;

function createRuntimeTts(): PluginRuntime["tts"] {
  const bindTtsRuntime = createLazyRuntimeMethodBinder(loadTtsRuntime);
  return {
    textToSpeech: bindTtsRuntime((runtime) => runtime.textToSpeech),
    textToSpeechTelephony: bindTtsRuntime((runtime) => runtime.textToSpeechTelephony),
    listVoices: bindTtsRuntime((runtime) => runtime.listSpeechVoices),
  };
}

function createRuntimeMediaUnderstandingFacade(): PluginRuntime["mediaUnderstanding"] {
  const bindMediaUnderstandingRuntime = createLazyRuntimeMethodBinder(
    loadMediaUnderstandingRuntime,
  );
  return {
    runFile: bindMediaUnderstandingRuntime((runtime) => runtime.runMediaUnderstandingFile),
    describeImageFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeImageFile),
    describeImageFileWithModel: bindMediaUnderstandingRuntime(
      (runtime) => runtime.describeImageFileWithModel,
    ),
    describeVideoFile: bindMediaUnderstandingRuntime((runtime) => runtime.describeVideoFile),
    transcribeAudioFile: bindMediaUnderstandingRuntime((runtime) => runtime.transcribeAudioFile),
  };
}

function createRuntimeImageGeneration(): PluginRuntime["imageGeneration"] {
  return {
    generate: (params) => generateRuntimeImage(params),
    listProviders: (params) => listRuntimeImageGenerationProviders(params),
  };
}

function createRuntimeVideoGeneration(): PluginRuntime["videoGeneration"] {
  return {
    generate: (params) => generateRuntimeVideo(params),
    listProviders: (params) => listRuntimeVideoGenerationProviders(params),
  };
}

function createRuntimeMusicGeneration(): PluginRuntime["musicGeneration"] {
  return {
    generate: (params) => generateRuntimeMusic(params),
    listProviders: (params) => listRuntimeMusicGenerationProviders(params),
  };
}

function createRuntimeModelAuth(): PluginRuntime["modelAuth"] {
  const getApiKeyForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getApiKeyForModel,
  );
  const getRuntimeAuthForModel = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.getRuntimeAuthForModel,
  );
  const resolveApiKeyForProvider = createLazyRuntimeMethod(
    loadModelAuthRuntime,
    (runtime) => runtime.resolveApiKeyForProvider,
  );
  return {
    getApiKeyForModel: (params) =>
      getApiKeyForModel({
        model: params.model,
        cfg: params.cfg,
      }),
    getRuntimeAuthForModel: (params) =>
      getRuntimeAuthForModel({
        model: params.model,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
    resolveApiKeyForProvider: (params) =>
      resolveApiKeyForProvider({
        provider: params.provider,
        cfg: params.cfg,
      }),
  };
}

export function createPluginRuntimeCore(
  options: CreatePluginRuntimeOptions = {},
): PluginRuntimeCoreAssembly {
  const mediaUnderstanding = createRuntimeMediaUnderstandingFacade();
  const taskFlow = createRuntimeTaskFlow();
  const tasks = createRuntimeTasks({
    legacyTaskFlow: taskFlow,
  });
  const runtime = {
    version: VERSION,
    config: createRuntimeConfig(),
    agent: createRuntimeAgent(),
    subagent: createGatewayBoundSubagentRuntime(
      options.subagent,
      options.allowGatewaySubagentBinding === true,
    ),
    system: createRuntimeSystem(),
    webSearch: {
      listProviders: listWebSearchProviders,
      search: runWebSearch,
    },
    channel: createPluginChannelRuntime(),
    events: createRuntimeEvents(),
    logging: createRuntimeLogging(),
    state: { resolveStateDir },
    tasks,
    taskFlow,
  } satisfies Omit<
    PluginRuntimeCoreAssembly,
    | "tts"
    | "mediaUnderstanding"
    | "stt"
    | "modelAuth"
    | "imageGeneration"
    | "videoGeneration"
    | "musicGeneration"
  > &
    Partial<
      Pick<
        PluginRuntimeCoreAssembly,
        | "tts"
        | "mediaUnderstanding"
        | "stt"
        | "modelAuth"
        | "imageGeneration"
        | "videoGeneration"
        | "musicGeneration"
      >
    >;

  defineCachedValue(runtime, "tts", createRuntimeTts);
  defineCachedValue(runtime, "mediaUnderstanding", () => mediaUnderstanding);
  defineCachedValue(runtime, "stt", () => ({
    transcribeAudioFile: mediaUnderstanding.transcribeAudioFile,
  }));
  defineCachedValue(runtime, "modelAuth", createRuntimeModelAuth);
  defineCachedValue(runtime, "imageGeneration", createRuntimeImageGeneration);
  defineCachedValue(runtime, "videoGeneration", createRuntimeVideoGeneration);
  defineCachedValue(runtime, "musicGeneration", createRuntimeMusicGeneration);

  return runtime as PluginRuntimeCoreAssembly;
}
