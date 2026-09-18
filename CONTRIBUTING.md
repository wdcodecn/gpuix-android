# Contributing

Use the repository that owns the change:

- Runtime, Android host, Hermes integration, CLI, packaging and device behavior:
  `gpuix-android`.
- Reusable React components, themes and component interaction semantics:
  `gpuix-base-ui`.
- Demo content and starter-specific configuration: `gpuix-app-starter`.

Before opening a pull request:

```sh
bun install
bun run typecheck
bun scripts/gpuix.ts help
npm pack --dry-run --ignore-scripts
```

Android behavior changes should include the exact build command, device/API
level, installed package identity, and runtime evidence. Do not include SDK
paths, device addresses, logs containing user data, signing files or generated
build directories.
