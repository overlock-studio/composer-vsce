# Overlock Studio Composer for VSCode

VS Code extension that opens configuration YAML files in a node-based visual editor (React Flow). Drag, connect, and edit resources on a canvas — every change is written back to YAML on disk. Node positions are persisted in a sibling `.layout.yaml` so the canvas stays put across reloads.

## Supported formats

| Format | Files | What you get |
| --- | --- | --- |
| Crossplane | `crossplane.yaml`, `crossplane.yml` | Visual editing of compositions, XRDs, resources, providers, functions, and connector edges across sibling YAML files in the same folder |

The Explorer marks matching files with a colored badge so they're easy to spot.

## Install

Grab the latest `.vsix` from releases (or build it locally with `yarn package`) and install it:

```bash
code --install-extension overlock-studio-composer-vsce-<version>.vsix
```

## Usage

1. Open a folder containing a `crossplane.yaml` (sibling YAML files in the same folder are loaded alongside it as part of the composition).
2. Right-click the file in the Explorer → **Open in Visual Editor**, or use the editor title bar button, or run **Overlock Studio Composer: Open in Visual Editor** from the Command Palette.
3. Edit on the canvas. `Ctrl+S` / `Cmd+S` saves both the YAML files and the layout.

The extension is registered with `priority: option`, so the plain text editor remains the default — switch back and forth via **Reopen Editor With…**.

### Behavior worth knowing

- **Live reload.** Editing the underlying YAML or `.layout.yaml` outside the visual editor (in another editor, by `git checkout`, etc.) is picked up automatically.
- **Conflict-safe saves.** Each loaded file is hashed when opened. If the on-disk file changes before you save, the extension opens a diff view (`<file> ↔ Overlock Composer (pending)`) instead of overwriting your work.
- **OCI block types.** Provider/function block schemas are fetched by the extension host (so auth and CORS aren't a problem) and handed to the webview on demand.

## Develop

```bash
yarn install
yarn build      # one-off build
yarn watch      # rebuild on change
```

Press `F5` in VS Code to launch the Extension Development Host with this extension loaded. The `tests/assets/gcp-platform/` fixture is a ready-made Crossplane configuration to open.

## Package

```bash
yarn package    # produces overlock-studio-composer-vsce-<version>.vsix
```
