import _ from 'lodash';
import {SmartBuffer} from 'smart-buffer';
import {DatabaseHdrType, RecordListType} from './database-header';
import {Record, SerializableBufferRecord} from './record';
import Serializable, {SerializableBuffer} from './serializable';

/** Represetation of a Palm OS PDB file. */
class Database<
  /** Record type. */
  RecordT extends Record,
  /** AppInfo type. */
  AppInfoT extends Serializable,
  /** SortInfo type. */
  SortInfoT extends Serializable
> implements Serializable {
  /** Database header.
   *
   * Note that some fields in the header are recomputed based on other
   * properties during serialization. See `recomputeHeader()` for details.
   */
  header: DatabaseHdrType = this.defaultHeader;
  /** AppInfo value. */
  appInfo: AppInfoT | null = null;
  /** SortInfo value. */
  sortInfo: SortInfoT | null = null;
  /** Record values. */
  records: Array<RecordT> = [];

  constructor({
    recordType,
    appInfoType,
    sortInfoType,
  }: {
    /** Record type constructor. */
    recordType: new () => RecordT;
    /** AppInfo type constructor. */
    appInfoType: new () => AppInfoT;
    /** SortInfo type constructor. */
    sortInfoType: new () => SortInfoT;
  }) {
    this.recordType = recordType;
    this.appInfoType = appInfoType;
    this.sortInfoType = sortInfoType;
  }

  /** Generates the default header for a new database. */
  get defaultHeader() {
    return new DatabaseHdrType();
  }

  /** Parses a PDB file. */
  parseFrom(buffer: Buffer) {
    this.header.parseFrom(buffer);
    const recordList = new RecordListType();
    recordList.parseFrom(buffer.slice(this.header.serializedLength));

    if (this.header.appInfoId) {
      const appInfoEnd =
        this.header.sortInfoId ||
        (recordList.numRecords > 0
          ? recordList.entries[0].localChunkId
          : buffer.length);
      this.appInfo = new this.appInfoType();
      this.appInfo.parseFrom(buffer.slice(this.header.appInfoId, appInfoEnd));
    } else {
      this.appInfo = null;
    }

    if (this.header.sortInfoId) {
      const sortInfoEnd =
        recordList.numRecords > 0
          ? recordList.entries[0].localChunkId
          : buffer.length;
      this.sortInfo = new this.sortInfoType();
      this.sortInfo.parseFrom(
        buffer.slice(this.header.sortInfoId, sortInfoEnd)
      );
    } else {
      this.sortInfo = null;
    }

    this.records.length = 0;
    for (let i = 0; i < recordList.numRecords; ++i) {
      const recordStart = recordList.entries[i].localChunkId;
      const recordEnd =
        i < recordList.numRecords - 1
          ? recordList.entries[i + 1].localChunkId
          : buffer.length;
      const record = new this.recordType();
      record.entry = recordList.entries[i];
      record.parseFrom(buffer.slice(recordStart, recordEnd));
      this.records.push(record);
    }
  }

  // Recomputed fields:
  //   - appInfoId
  //   - sortInfoId
  //   - localChunkId for each recordEntry.
  serialize() {
    const recordList = new RecordListType();
    recordList.numRecords = this.records.length;
    recordList.entries = _.map(this.records, 'entry');

    let offset = this.header.serializedLength + recordList.serializedLength;
    if (this.appInfo) {
      this.header.appInfoId = offset;
      offset += this.appInfo.serializedLength;
    } else {
      this.header.appInfoId = 0;
    }
    if (this.sortInfo) {
      this.header.sortInfoId = offset;
      offset += this.sortInfo.serializedLength;
    } else {
      this.header.sortInfoId = 0;
    }

    for (let i = 0; i < this.records.length; ++i) {
      recordList.entries[i].localChunkId = offset;
      offset += this.records[i].serializedLength;
    }

    const writer = SmartBuffer.fromOptions({encoding: 'ascii'});
    writer.writeBuffer(this.header.serialize());
    writer.writeBuffer(recordList.serialize());
    if (this.appInfo) {
      writer.writeBuffer(this.appInfo.serialize());
    }
    if (this.sortInfo) {
      writer.writeBuffer(this.sortInfo.serialize());
    }
    for (const record of this.records) {
      writer.writeBuffer(record.serialize());
    }
    return writer.toBuffer();
  }

  get serializedLength() {
    return this.serialize().length;
  }

  private readonly recordType: new () => RecordT;
  private readonly appInfoType: new () => AppInfoT;
  private readonly sortInfoType: new () => SortInfoT;
}

export default Database;

/** Database specialization providing records, AppInfo and SortInfo as raw buffers. */
export class RawDatabase extends Database<
  SerializableBufferRecord,
  SerializableBuffer,
  SerializableBuffer
> {
  constructor() {
    super({
      recordType: SerializableBufferRecord,
      appInfoType: SerializableBuffer,
      sortInfoType: SerializableBuffer,
    });
  }
}
