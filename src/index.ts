// noinspection JSUnusedGlobalSymbols

import {
  BaseVFS,
  Data,
  NumberSetter,
  ResultCode,
  SQLITE,
  SQLITE_ACCESS,
  SQLITE_IOCAP,
  SQLITE_IOERR
} from "wa-sqlite-base";
import { Instance as WebTorrent, Torrent, TorrentFile } from "webtorrent";

interface Opts {
  prefetch: boolean,
  timeout: number
}

const DEFAULTS: Opts = {
  prefetch: false,
  timeout: 5000
}

export class WebTorrentVFS extends BaseVFS {

  private readonly client: WebTorrent | undefined
  private readonly torrent: Torrent

  private readonly opts: Opts
  private readonly mapIdToFile: Map<number, TorrentFile>

  private readonly timeout: ReturnType<typeof setTimeout>
  private readonly ready: DeferredPromise

  constructor(torrent: string | Uint8Array | Blob | Torrent, opts: Opts = DEFAULTS) {
    super();

    this.opts = {
      prefetch: opts.prefetch || DEFAULTS.prefetch,
      timeout: opts.timeout || DEFAULTS.timeout
    };
    this.mapIdToFile = new Map();

    this.ready = new DeferredPromise();
    this.ready.finally(() => {
      if (this.torrent && this.torrent.ready) {
        console.log("torrent is ready");
        if (this.timeout) {
          clearTimeout(this.timeout);
        }
      }
    });

    if (torrent && torrent.constructor.name === "Torrent") { // very bad check if torrent is a WebTorrent.Torrent instance
      this.torrent = torrent as Torrent;
      if (this.torrent.ready) {
        this.ready.resolve();
      } else {
        this.torrent.on("ready", () => {
          this.ready.resolve();
        });
      }
    } else {
      // @ts-ignore
      // FIXME could not get webtorrent & its dependency to work nicely with es modules
      //  just assume it was added via a script tag for now
      this.client = new window.WebTorrent();
      // @ts-ignore
      this.torrent = this.client!!.add(torrent, {
        // store: could use indexeddb-chunk-store for persistence
      }, (torrent) => {
        this.ready.resolve();

        // always stop auto downloading when we control the torrent
        torrent.deselect(0, torrent.pieces.length - 1, 0);
      });
    }

    // start timeout last so we can be sure torrent was added/created
    this.timeout = setTimeout(() => {
      this.ready.reject(`Torrent was not ready after ${this.opts.timeout} ms`);
    }, this.opts.timeout);
  }

  override name(): string {
    return "webtorrent";
  }

  override close(): void {
    if (this.client) {
      this.client.destroy();
    }
  }

  override xOpen(name: string | null, fileId: number, flags: number, pOutFlags: NumberSetter): ResultCode {
    return this.handleAsync(async () => {
      console.debug(`xOpen name:${name} fileId:${fileId} flags:${flags}`);

      const file = await this.findFile(name);
      if (!file) {
        return SQLITE.CANTOPEN;
      }

      // Put the file in the opened files map.
      this.mapIdToFile.set(fileId, file);

      if (this.opts.prefetch) {
        file.select(); // start auto downloading
      }

      pOutFlags.set(flags);
      return SQLITE.OK;
    });
  }

  override xClose(fileId: number): SQLITE {
    console.debug(`xClose fileId:${fileId}`);
    const file = this.mapIdToFile.get(fileId);
    if (file && this.client) {
      // stop auto downloading, only if we also control the torrent
      file.deselect(); // does not work according to docs (https://github.com/webtorrent/webtorrent/issues/164) ?
    }
    this.mapIdToFile.delete(fileId);
    return SQLITE.OK;
  }

  override xRead(fileId: number, pData: Data, iOffset: number): ResultCode {
    return this.handleAsync(async () => {
      console.debug(`xRead fileId:${fileId} offset:${iOffset} size:${pData.size}`);
      const file = this.mapIdToFile.get(fileId);
      if (!file) {
        return SQLITE.IOERR;
      }

      const stream = file.createReadStream({
        start: iOffset,
        end: iOffset + pData.size - 1 // -1 because end is inclusive
      });

      let arrayOffset = 0;

      return new Promise(((resolve, reject) => {
        stream.on("error", (err) => {
          console.error("read stream error");
          console.error(err);
          resolve(SQLITE.IOERR);
        });
        stream.on("end", () => {
          if (arrayOffset !== pData.size) {
            // zero unused area of read buffer.
            pData.value.fill(0, arrayOffset);
            resolve(SQLITE_IOERR.SHORT_READ);
          } else {
            resolve(SQLITE.OK);
          }
        });
        stream.on("data", (chunk) => {
          pData.value.subarray(arrayOffset).set(new Int8Array(chunk));
          arrayOffset += chunk.length;
        });
      }));
    });
  }

  override xFileSize(fileId: number, pSize64: NumberSetter): SQLITE {
    const file = this.mapIdToFile.get(fileId);
    if (!file) {
      return SQLITE.IOERR;
    }
    console.debug(`xFileSize fileId:${fileId} -> ${file.length}`);
    pSize64.set(file.length);
    return SQLITE.OK;
  }

  override xDeviceCharacteristics(fileId: number): SQLITE_IOCAP {
    return SQLITE_IOCAP.IMMUTABLE;
  }

  override xAccess(name: string, flags: number, pResOut: NumberSetter): ResultCode {
    return this.handleAsync(async () => {
      console.debug(`xAccess name:${name} flags:${flags}`);
      const file = await this.findFile(name);
      if (file && (flags === SQLITE_ACCESS.EXISTS || flags === SQLITE_ACCESS.READ)) {
        pResOut.set(1);
      } else {
        pResOut.set(0);
      }
      return SQLITE.OK;
    });
  }

  async waitUntilTorrentIsReady(): Promise<void> {
    if (!this.torrent.ready) {
      console.debug("waiting for torrent to be ready...");
      await this.ready;
    }
  }

  /**
   * Search file in torrent
   */
  async findFile(name: string | null): Promise<TorrentFile | null> {
    try {
      await this.waitUntilTorrentIsReady();
    } catch (err) {
      console.error(err);
      return null;
    }

    for (let file of this.torrent.files) {
      if (file.path === name) {
        return file;
      }
    }
    console.error(`\"${name}\" does not exist in ${this.torrent.files}`)
    return null;
  }
}

// adapted from https://stackoverflow.com/a/47112177
class DeferredPromise implements Promise<void> {
  readonly [Symbol.toStringTag]: string = "DeferredPromise";

  private readonly _promise: Promise<void>

  // @ts-ignore
  public resolve: (value: PromiseLike<void> | void) => void
  // @ts-ignore
  public reject: (reason?: any) => void

  public then: any
  public catch: any
  public finally: any

  constructor() {
    this._promise = new Promise((resolve, reject) => {
      // assign the resolve and reject functions to `this`
      // making them usable on the class instance
      this.resolve = resolve;
      this.reject = reject;
    });
    // bind `then` and `catch` to implement the same interface as Promise
    this.then = this._promise.then.bind(this._promise);
    this.catch = this._promise.catch.bind(this._promise);
    this.finally = this._promise.finally.bind(this._promise);
  }
}