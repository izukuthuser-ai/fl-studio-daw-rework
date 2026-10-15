// Thin wrapper over the Electron preload API with browser fallbacks, so the app also
// runs (and can be tested) in a normal browser.

export interface FileFilter {
  name: string;
  extensions: string[];
}
export interface OpenedFile {
  path: string;
  name: string;
  data: Uint8Array;
}
export interface AudioListing {
  path: string;
  name: string;
  rel: string;
}

interface ElectronAPI {
  openFile(opts: { title?: string; filters?: FileFilter[]; multi?: boolean }): Promise<OpenedFile[] | null>;
  saveFile(opts: { title?: string; defaultPath?: string; filters?: FileFilter[]; data: Uint8Array | string }): Promise<string | null>;
  writeFile(path: string, data: Uint8Array | string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  pickFolder(): Promise<string | null>;
  listAudio(dir: string): Promise<AudioListing[]>;
  pathForFile(file: File): string;
  onRequestClose(cb: () => void): void;
  confirmClose(): void;
  getLaunchFile(): Promise<string | null>;
  onOpenFile(cb: (path: string) => void): void;
  setTitle(title: string): void;
  autosaveWrite(data: string): Promise<boolean>;
  autosaveRead(): Promise<string | null>;
  platform: string;
  version: string;
}

const api: ElectronAPI | undefined = (globalThis as any).native;

export const isElectron = !!api;
export const appVersion = api?.version ?? '0.1.0-web';

function pickViaInput(accept: string, multi: boolean): Promise<File[] | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multi;
    inp.style.display = 'none';
    document.body.append(inp);
    inp.onchange = () => {
      resolve(inp.files ? Array.from(inp.files) : null);
      inp.remove();
    };
    inp.click();
  });
}

export const native = {
  async openFile(opts: { title?: string; filters?: FileFilter[]; multi?: boolean }): Promise<OpenedFile[] | null> {
    if (api) return api.openFile(opts);
    const accept = (opts.filters ?? []).flatMap((f) => f.extensions.map((e) => (e === '*' ? '*/*' : '.' + e))).join(',');
    const files = await pickViaInput(accept, !!opts.multi);
    if (!files || !files.length) return null;
    return Promise.all(files.map(async (f) => ({ path: f.name, name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  },
  async saveFile(opts: { title?: string; defaultPath?: string; filters?: FileFilter[]; data: Uint8Array | string }): Promise<string | null> {
    if (api) return api.saveFile(opts);
    const name = opts.defaultPath?.split(/[\\/]/).pop() || 'download';
    const blob = new Blob([opts.data as BlobPart]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    return name;
  },
  async writeFile(path: string, data: Uint8Array | string): Promise<boolean> {
    if (api) return api.writeFile(path, data);
    await native.saveFile({ defaultPath: path, data });
    return true;
  },
  async readFile(path: string): Promise<Uint8Array | null> {
    if (api) {
      try {
        return await api.readFile(path);
      } catch {
        return null;
      }
    }
    return null;
  },
  async pickFolder(): Promise<string | null> {
    return api ? api.pickFolder() : null;
  },
  async listAudio(dir: string): Promise<AudioListing[]> {
    return api ? api.listAudio(dir) : [];
  },
  pathForFile(file: File): string | null {
    if (!api) return null;
    try {
      return api.pathForFile(file) || null;
    } catch {
      return null;
    }
  },
  onRequestClose(cb: () => void) {
    api?.onRequestClose(cb);
  },
  confirmClose() {
    api?.confirmClose();
  },
  async getLaunchFile(): Promise<string | null> {
    return api ? api.getLaunchFile() : null;
  },
  onOpenFile(cb: (path: string) => void) {
    api?.onOpenFile(cb);
  },
  setTitle(t: string) {
    if (api) api.setTitle(t);
    document.title = t;
  },
  async autosaveWrite(data: string) {
    try {
      localStorage.setItem('lf.autosave', data);
    } catch {}
    if (api) await api.autosaveWrite(data).catch(() => false);
  },
  async autosaveRead(): Promise<string | null> {
    if (api) {
      const d = await api.autosaveRead().catch(() => null);
      if (d) return d;
    }
    try {
      return localStorage.getItem('lf.autosave');
    } catch {
      return null;
    }
  },
};

export function basename(p: string) {
  return p.split(/[\\/]/).pop() ?? p;
}
