import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPatch } from "./apply-patch.js";
import { createExecTool } from "./bash-tools.exec.js";
import { buildRawJsonEditRejectionMessage, detectRawJsonExecWrite } from "./json-edit-guard.js";
import { createHostWorkspaceEditTool, createSandboxedEditTool } from "./pi-tools.read.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

async function sha256(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

function expectGuardMessage(error: unknown) {
  expect(String(error)).toMatch(/json-safe-edit/i);
  expect(String(error)).toMatch(/serializer/i);
  expect(String(error)).toMatch(/temp/i);
  expect(String(error)).toMatch(/validate/i);
}

describe("runtime JSON edit guard", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  async function makeWorkspace() {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-edit-guard-"));
    return tmpDir;
  }

  it.each(["standing-orders.json", "foo.json", "foo.jsonl"])(
    "host edit rejects %s before mutation and leaves hash unchanged",
    async (fileName) => {
      const dir = await makeWorkspace();
      const filePath = path.join(dir, fileName);
      await fs.writeFile(
        filePath,
        fileName.endsWith(".jsonl") ? '{"old":true}\n' : '{"old":true}\n',
        "utf8",
      );
      const before = await sha256(filePath);
      const edit = createHostWorkspaceEditTool(dir, { workspaceOnly: true });

      let thrown: unknown;
      try {
        await edit.execute("call", {
          path: fileName,
          edits: [{ oldText: "old", newText: "new" }],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expectGuardMessage(thrown);
      await expect(sha256(filePath)).resolves.toBe(before);
    },
  );

  it("host edit still allows markdown mutation", async () => {
    const dir = await makeWorkspace();
    await fs.writeFile(path.join(dir, "note.md"), "old\n", "utf8");
    const edit = createHostWorkspaceEditTool(dir, { workspaceOnly: true });

    await edit.execute("call", {
      path: "note.md",
      edits: [{ oldText: "old", newText: "new" }],
    });

    await expect(fs.readFile(path.join(dir, "note.md"), "utf8")).resolves.toBe("new\n");
  });

  it("sandboxed edit rejects JSON target using container path mapping", async () => {
    const files = new Map([["/sandbox/standing-orders.json", '{"old":true}\n']]);
    const bridge: SandboxFsBridge = {
      resolvePath: ({ filePath }) => ({
        relativePath: filePath,
        containerPath: `/sandbox/${filePath}`,
      }),
      readFile: async ({ filePath }) =>
        Buffer.from(files.get(filePath) ?? files.get(`/sandbox/${filePath}`) ?? "", "utf8"),
      writeFile: async ({ filePath, data }) => {
        files.set(filePath, Buffer.isBuffer(data) ? data.toString("utf8") : data);
      },
      remove: async ({ filePath }) => {
        files.delete(filePath);
      },
      rename: async ({ from, to }) => {
        const value = files.get(from);
        if (value !== undefined) {
          files.set(to, value);
          files.delete(from);
        }
      },
      stat: async () => ({ type: "file", size: 1, mtimeMs: 0 }),
      mkdirp: async () => {},
    };
    const edit = createSandboxedEditTool({ root: "/workspace", bridge });

    await expect(
      edit.execute("call", {
        path: "standing-orders.json",
        edits: [{ oldText: "old", newText: "new" }],
      }),
    ).rejects.toThrow(/json-safe-edit/i);
    expect(files.get("/sandbox/standing-orders.json")).toBe('{"old":true}\n');
  });

  it("applyPatch rejects JSON/JSONL and move targets before mutation", async () => {
    const dir = await makeWorkspace();
    await fs.writeFile(path.join(dir, "standing-orders.json"), '{"old":true}\n', "utf8");
    await fs.writeFile(path.join(dir, "foo.jsonl"), '{"old":true}\n', "utf8");
    await fs.writeFile(path.join(dir, "source.md"), "old\n", "utf8");
    const beforeStanding = await sha256(path.join(dir, "standing-orders.json"));
    const beforeJsonl = await sha256(path.join(dir, "foo.jsonl"));
    const beforeSource = await sha256(path.join(dir, "source.md"));

    const standingPatch = `*** Begin Patch\n*** Update File: standing-orders.json\n@@\n-{\"old\":true}\n+{\"old\":false}\n*** End Patch`;
    const jsonlPatch = `*** Begin Patch\n*** Update File: foo.jsonl\n@@\n-{\"old\":true}\n+{\"old\":false}\n*** End Patch`;
    const movePatch = `*** Begin Patch\n*** Update File: source.md\n*** Move to: target.json\n@@\n-old\n+new\n*** End Patch`;

    for (const patch of [standingPatch, jsonlPatch, movePatch]) {
      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/json-safe-edit/i);
    }
    await expect(sha256(path.join(dir, "standing-orders.json"))).resolves.toBe(beforeStanding);
    await expect(sha256(path.join(dir, "foo.jsonl"))).resolves.toBe(beforeJsonl);
    await expect(sha256(path.join(dir, "source.md"))).resolves.toBe(beforeSource);
  });

  it("applyPatch still allows markdown-only patches", async () => {
    const dir = await makeWorkspace();
    await fs.writeFile(path.join(dir, "note.md"), "old\n", "utf8");
    await applyPatch(`*** Begin Patch\n*** Update File: note.md\n@@\n-old\n+new\n*** End Patch`, {
      cwd: dir,
    });
    await expect(fs.readFile(path.join(dir, "note.md"), "utf8")).resolves.toBe("new\n");
  });

  it("exec blocks high-signal protected JSON writes before process execution", async () => {
    const dir = await makeWorkspace();
    const exec = createExecTool({ cwd: dir, security: "full", ask: "off" });
    for (const command of [
      "sed -i '' s/old/new/ standing-orders.json",
      "python3 -c \"from pathlib import Path; Path('standing-orders.json').write_text('{}')\"",
      "echo '{}' > standing-orders.json",
    ]) {
      await expect(exec.execute("call", { command })).rejects.toThrow(/json-safe-edit/i);
    }
  });

  it("exec detector blocks high-signal protected JSON writes and allows read-only commands", () => {
    const blocked = [
      "sed -i '' s/old/new/ standing-orders.json",
      "perl -pi -e 's/old/new/' current-project.json",
      "tee standing-orders.json",
      "printf '{}' | tee standing-orders.json",
      "echo '{}' > standing-orders.json",
      "jq '.x=1' standing-orders.json > current-project.json",
      "python3 - <<'PY'\nfrom pathlib import Path\nPath('standing-orders.json').write_text('{}')\nPY",
      "python -c \"open('standing-orders.json', 'w').write('{}')\"",
      "node -e \"require('fs').writeFileSync('standing-orders.json','{}')\"",
      "node -e \"require('fs').writeFile('standing-orders.json','{}',()=>{})\"",
      "node -e \"require('fs').promises.writeFile('standing-orders.json','{}')\"",
      "node --input-type=module -e \"import fs from 'node:fs'; fs.writeFileSync('standing-orders.json','{}')\"",
      "echo '{}' >> events.ledger.jsonl",
    ];
    for (const command of blocked) {
      expect(detectRawJsonExecWrite(command), command).toMatchObject({ blocked: true });
      expect(buildRawJsonEditRejectionMessage(command)).toMatch(
        /json-safe-edit.*serializer.*temp.*validate/is,
      );
    }

    const allowed = [
      "python3 -m json.tool standing-orders.json",
      "jq . standing-orders.json",
      "cat standing-orders.json",
      "rg pattern standing-orders.json",
      "node -e \"require('fs').readFileSync('standing-orders.json','utf8')\"",
    ];
    for (const command of allowed) {
      expect(detectRawJsonExecWrite(command), command).toMatchObject({ blocked: false });
    }
  });
});
