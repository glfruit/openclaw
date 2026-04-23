# OpenClaw (glfruit fork)

This repository is a maintained fork of [`openclaw/openclaw`](https://github.com/openclaw/openclaw), the original OpenClaw project.

## Fork notice

- **Upstream**: `openclaw/openclaw` is the original project and primary upstream source.
- **This fork**: `glfruit/openclaw` may carry local patches, release timing differences, and workflow changes that are not present upstream.
- **Authority contract**: if this fork's code, tags, history, or docs differ from upstream material, trust **this repository first** for behavior shipped from `glfruit/openclaw`.

## What this fork is

`glfruit/openclaw` keeps the OpenClaw codebase available for fork-local development and distribution. It is best treated as a source-first fork for people who want to inspect, build, patch, or run this repo directly.

Because this fork may diverge from upstream, do not assume upstream badges, release channels, package publishing, or hosted docs automatically describe this repo.

## Upstream relationship

Upstream documentation and discussions can still be useful background, but they are **reference material only** unless this fork says otherwise.

Useful upstream references:

- Upstream repo: <https://github.com/openclaw/openclaw>
- Upstream docs: <https://docs.openclaw.ai>

When reading upstream docs, verify commands, defaults, and release assumptions against the code and files in this fork.

## Install / run this fork from source

This README intentionally avoids claiming any fork-specific published package or installer. The conservative path is to run from source:

```bash
git clone https://github.com/glfruit/openclaw.git
cd openclaw
pnpm install
pnpm build
```

After building, you can run the local CLI from the checkout, for example:

```bash
node openclaw.mjs --help
pnpm openclaw --help
```

If you want guided setup after building, use the CLI in this checkout rather than assuming an upstream global install:

```bash
pnpm openclaw onboard
```

## Development workflow

Typical fork-local development flow:

```bash
git clone https://github.com/glfruit/openclaw.git
cd openclaw
pnpm install
pnpm build
pnpm gateway:watch
```

Notes:

- `pnpm` is the verified package manager path in this repo.
- `pnpm openclaw ...` runs the CLI from this checkout.
- Rebuild and re-check locally before relying on behavior documented upstream.

## Docs policy for this fork

Use materials in this repository as the source of truth for this fork:

- repository files
- commit history
- tags/releases published from this fork
- fork-local docs or notes

Use upstream docs only as a supplement. If there is a conflict, assume the fork has intentionally diverged until verified otherwise.

## Contributing and maintenance

For fork-specific behavior, patches, or release concerns, open issues and pull requests against `glfruit/openclaw`.

For changes intended for the original project, or for questions about upstream roadmap and policy, prefer `openclaw/openclaw`.

Contributors working in this fork should keep changes narrow, document fork-only behavior clearly, and avoid assuming upstream maintainers will review or ship fork-local work.

## Attribution

OpenClaw was originally created and is primarily developed in the upstream [`openclaw/openclaw`](https://github.com/openclaw/openclaw) project.

This fork preserves that work while carrying local changes in `glfruit/openclaw`. See [`LICENSE`](LICENSE) and the repository history for attribution details.
