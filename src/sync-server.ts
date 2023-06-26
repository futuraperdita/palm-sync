import debug from 'debug';
import {EventEmitter} from 'events';
import {createServer, Server, Socket} from 'net';
import pEvent from 'p-event';
import {Duplex} from 'stream';
import {
  DlpEndOfSyncReqType,
  DlpReadSysInfoReqType,
  DlpReadUserInfoReqType,
} from './dlp-commands';
import {DlpConnection} from './dlp-protocol';
import {StreamRecorder} from './stream-recorder';

/** Base class for HotSync connections.
 *
 * This class is extended by each protocol stack.
 */
export abstract class SyncConnection<DlpStreamT extends Duplex = Duplex> {
  /** Set up a HotSync connection based on an underying raw data stream. */
  constructor(rawStream: Duplex) {
    this.log = debug('palm-dlp').extend('sync');
    this.rawStream = rawStream;

    if (this.rawStream instanceof Socket) {
      this.log = this.log.extend(this.rawStream.remoteAddress ?? 'UNKNOWN');
    }

    this.dlpStream = this.createDlpStream(this.recorder.record(this.rawStream));
    this.dlpConnection = new DlpConnection(this.dlpStream);

    this.log(`Connection established`);

    if (this.rawStream instanceof Socket) {
      this.rawStream.setNoDelay(true);
    }

    // The DLP stream should propagate errors through, so we only need to listen
    // for errors at the DLP stream level.
    const errorListener = (e: Error) => {
      this.log('Connection error: ' + (e.stack ? `${e.stack}` : e.message));
    };
    this.dlpStream.on('error', errorListener);

    this.rawStream.on('close', (hadError: any) => {
      this.log(`Connection closed${hadError ? ' with errors' : ''}`);
      // If there was an error thrown from rawStream, duplexify may emit another
      // error event when destroyed. So to prevent duplicate errors, we will
      // ignore all errors after the raw stream is closed.
      this.dlpStream
        .removeListener('error', errorListener)
        // Don't crash on error.
        .on('error', () => {});
    });
  }

  /** Create a stream yielding DLP datagrams based on a raw data stream. */
  abstract createDlpStream(rawStream: Duplex): DlpStreamT;

  /** Perform initial handshake with the Palm device to00000 establish connection. */
  abstract doHandshake(): Promise<void>;

  /** Common DLP operations to run at the start of a HotSync session. */
  async start() {
    const sysInfoResp = await this.dlpConnection.execute(
      new DlpReadSysInfoReqType()
    );
    this.log(JSON.stringify(sysInfoResp));
    const userInfoResp = await this.dlpConnection.execute(
      new DlpReadUserInfoReqType()
    );
    this.log(JSON.stringify(userInfoResp));
  }

  /** Common DLP operations to run at the end of a HotSync session. */
  async end() {
    await this.dlpConnection.execute(new DlpEndOfSyncReqType());
  }

  /** DLP connection for communicating with the device. */
  dlpConnection: DlpConnection;
  /** Recorder for the raw stream. */
  recorder = new StreamRecorder();
  /** Logger. */
  protected log: debug.Debugger;
  /** Stream for reading / writing DLP datagrams. */
  protected dlpStream: DlpStreamT;
  /** Raw data stream underlying the DLP stream. */
  protected rawStream: Duplex;
}

/** A function that implements HotSync business logic. */
export type SyncFn = (connection: SyncConnection) => Promise<void>;

/** Base class for network-based sync servers. */
export abstract class NetworkSyncServer<
  SyncConnectionT extends SyncConnection
> extends EventEmitter {
  /** Constructor for the corresponding connection type. */
  abstract connectionType: new (rawStream: Duplex) => SyncConnectionT;
  /** Port to listen on. */
  abstract port: number;

  constructor(syncFn: SyncFn) {
    super();
    this.syncFn = syncFn;
  }

  start() {
    if (this.server) {
      throw new Error('Server already started');
    }
    this.server = createServer(this.onConnection.bind(this));
    this.server.listen(this.port, () => {
      this.log(`Server started on port ${this.port}`);
    });
  }

  async stop() {
    if (!this.server) {
      return;
    }
    this.server.close();
    await pEvent(this.server, 'close');
  }

  async onConnection(rawStream: Duplex) {
    const connection = new this.connectionType(rawStream);
    this.emit('connect', connection);

    this.log('Starting handshake');
    await connection.doHandshake();
    this.log('Handshake complete');

    await connection.start();

    await this.syncFn(connection);

    await connection.end();
    this.emit('disconnect', connection);
  }

  /** HotSync logic to run when a connection is made. */
  syncFn: SyncFn;
  /** The underlying net.Server. */
  protected server: Server | null = null;
  /** Debugger. */
  private log = debug('palm-dlp').extend('sync');
}
