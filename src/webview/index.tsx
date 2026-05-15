import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ComposerEditor,
  parseCrossplaneDependencies,
  type BlockType,
  type ComposerEditorHandle,
  type ComposerSavePayload,
  type ConfigurationDB,
  type CrossplaneFile,
  type CrossplaneProviderDB,
  type EditorDataAdapter,
  type LayoutByComposition,
  type PackageDependency,
} from '@overlock-studio/composer';

declare const acquireVsCodeApi: () => {
  postMessage: (msg: unknown) => void;
};

const vscode = acquireVsCodeApi();

const CONFIG_ID = 'extension';

type PendingResolver = (value: BlockType[]) => void;
type PendingRejector = (reason: Error) => void;
const pending = new Map<
  string,
  { resolve: PendingResolver; reject: PendingRejector }
>();

window.addEventListener('message', (event) => {
  const msg = event.data as {
    type?: string;
    requestId?: string;
    blockTypes?: BlockType[];
    error?: string;
  };
  if (msg?.type !== 'getBlockTypesResult' || !msg.requestId) return;
  const slot = pending.get(msg.requestId);
  if (!slot) return;
  pending.delete(msg.requestId);
  if (msg.error) slot.reject(new Error(msg.error));
  else slot.resolve(msg.blockTypes ?? []);
});

const requestBlockTypes = (url: string): Promise<BlockType[]> =>
  new Promise<BlockType[]>((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pending.set(requestId, { resolve, reject });
    vscode.postMessage({ type: 'getBlockTypes', requestId, url });
  });

const depsToProviders = (deps: PackageDependency[]): CrossplaneProviderDB[] =>
  deps
    .filter((d) => d.kind === 'provider')
    .map((d) => {
      const id = d.version ? `${d.package}:${d.version}` : d.package;
      const segments = d.package.split('/');
      const title = segments[segments.length - 1] || d.package;
      const familyName =
        segments.length > 1 ? segments[segments.length - 2] : '';
      return {
        _id: id,
        title,
        description: '',
        icon: '',
        family: familyName,
        familyName,
        url: d.package,
        version: d.version || undefined,
      };
    });

const buildAdapter = (deps: PackageDependency[]): EditorDataAdapter => {
  const providers = depsToProviders(deps);
  const configuration: ConfigurationDB = {
    _id: CONFIG_ID,
    name: 'crossplane.yaml',
    providers: providers.map((p) => p._id),
    functions: deps.filter((d) => d.kind === 'function').map((d) => d.package),
    deployId: null,
  };

  return {
    getBlocks: async () => [],
    updateBlocks: async () => null,
    getBlockTypes: async (url: string) => requestBlockTypes(url),
    getConfiguration: async (id: string) =>
      id === CONFIG_ID ? configuration : null,
    getTemplate: async () => null,
    listCrossplaneProviders: async () => ({
      crossplaneProviders: providers,
      totalCount: providers.length,
    }),
    getConfigurationData: async () => ({
      compositions: [],
      xrdBlockType: [],
      providerUrls: [],
      functionUrls: [],
    }),
    createConfiguration: async () => '',
    updateConfiguration: async () => undefined,
    createProvidersFromUrls: async () => [],
    createFunctionsFromUrls: async () => [],
  };
};

type DocState = {
  uri: string;
  crossplaneFile: string;
  files: CrossplaneFile[];
  hashes: Record<string, string>;
  layout: LayoutByComposition;
  deps: PackageDependency[];
};

type DocumentMessage = {
  type: 'document';
  uri?: string;
  crossplaneFile?: string;
  files?: CrossplaneFile[];
  hashes?: Record<string, string>;
  layout?: LayoutByComposition;
};

type SaveResultMessage = {
  type: 'saveResult';
  hashes?: Record<string, string>;
};

function App() {
  const [doc, setDoc] = useState<DocState | null>(null);
  const composerRef = useRef<ComposerEditorHandle | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const raw = event.data as { type?: string };
      if (raw?.type === 'document') {
        const msg = raw as DocumentMessage;
        const files = msg.files ?? [];
        const crossplaneFile =
          msg.crossplaneFile ?? files[0]?.name ?? 'crossplane.yaml';
        const crossplaneContent =
          files.find((f) => f.name === crossplaneFile)?.content ?? '';
        const deps = parseCrossplaneDependencies(crossplaneContent);
        setDoc({
          uri: msg.uri ?? '',
          crossplaneFile,
          files,
          hashes: msg.hashes ?? {},
          layout: msg.layout ?? {},
          deps,
        });
        return;
      }
      if (raw?.type === 'saveResult') {
        const msg = raw as SaveResultMessage;
        const newHashes = msg.hashes ?? {};
        setDoc((prev) => {
          if (!prev) return prev;
          return { ...prev, hashes: { ...prev.hashes, ...newHashes } };
        });
        return;
      }
      if (raw?.type === 'requestSave') {
        composerRef.current?.save();
        return;
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const adapter = useMemo(() => buildAdapter(doc?.deps ?? []), [doc?.deps]);

  const handleSave = (payload: ComposerSavePayload) => {
    vscode.postMessage({ type: 'saveDocument', ...payload });
  };

  if (!doc) return null;

  return (
    <ComposerEditor
      ref={composerRef}
      files={doc.files}
      crossplaneFile={doc.crossplaneFile}
      hashes={doc.hashes}
      layout={doc.layout}
      adapter={adapter}
      entityRef={{ entity: 'configuration', entityId: CONFIG_ID }}
      onSave={handleSave}
    />
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
