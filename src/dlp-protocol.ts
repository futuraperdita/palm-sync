import debug from 'debug';
import _ from 'lodash';
import pEvent from 'p-event';
import 'reflect-metadata';
import {SmartBuffer} from 'smart-buffer';
import stream from 'stream';
import {
  ParseOptions,
  SBuffer,
  Serializable,
  SerializablePropertySpec,
  SerializableWrapper,
  SERIALIZABLE_PROPERTY_SPECS_METADATA_KEY,
  serialize,
  serializeAs,
  SerializeOptions,
} from './serializable';

/** Key for storing DLP argument information on a DlpRequest / DlpResponse. */
export const DLP_ARG_SPECS_METADATA_KEY = Symbol('dlpArgSpecs');

/** Metadata stored for each DLP argument. */
export interface DlpArgSpec<ValueT = any>
  extends SerializablePropertySpec<ValueT> {
  /** The DLP argument ID. */
  argId: number;
}

/** Decorator for a DLP argument property. */
export function dlpArg<ValueT>(
  argId: number,
  serializableWrapperClass?: new () => SerializableWrapper<ValueT>
): PropertyDecorator {
  return function (target: Object, propertyKey: string | symbol) {
    // Use serialize / serializeAs to add basic to
    // SERIALIZABLE_PROPERTY_SPECS_METADATA_KEY
    if (serializableWrapperClass) {
      serializeAs(serializableWrapperClass)(target, propertyKey);
    } else {
      serialize(target, propertyKey);
    }
    // Augment and move metadata to DLP_ARG_SPECS_METADATA_KEY.
    const serializablePropertySpecs = Reflect.getMetadata(
      SERIALIZABLE_PROPERTY_SPECS_METADATA_KEY,
      target
    ) as Array<SerializablePropertySpec>;
    const dlpArgSpec: DlpArgSpec = {
      ...serializablePropertySpecs.pop()!,
      argId,
    };
    const dlpArgSpecs = Reflect.getMetadata(
      DLP_ARG_SPECS_METADATA_KEY,
      target
    ) as Array<DlpArgSpec> | undefined;
    if (dlpArgSpecs) {
      dlpArgSpecs.push(dlpArgSpec);
    } else {
      Reflect.defineMetadata(DLP_ARG_SPECS_METADATA_KEY, [dlpArgSpec], target);
    }
  };
}

/** Extract DlpArgSpec's defined via dlpArg on a DlpRequest or DlpResponse. */
export function getDlpArgSpecs(target: Object) {
  return (Reflect.getMetadata(
    DLP_ARG_SPECS_METADATA_KEY,
    Object.getPrototypeOf(target)
  ) ?? []) as Array<DlpArgSpec>;
}

/** Constructs DlpArg's on a DlpRequest or DlpResponse. */
export function getDlpArgs(target: Object) {
  const dlpArgSpecs = getDlpArgSpecs(target);
  return dlpArgSpecs.map(({propertyKey, argId, wrapper}) => {
    const propOrWrapper =
      wrapper ?? ((target as any)[propertyKey] as Serializable);
    return new DlpArg(argId, propOrWrapper);
  });
}

/** Base class for DLP requests. */
export abstract class DlpRequest<DlpResponseT extends DlpResponse>
  implements Serializable
{
  /** DLP command ID. */
  abstract commandId: number;

  /** The response class corresponding to this request. */
  abstract responseType: new () => DlpResponseT;

  parseFrom(buffer: Buffer, opts?: ParseOptions): number {
    const reader = SmartBuffer.fromBuffer(buffer);

    const actualCommandId = reader.readUInt8();
    if (actualCommandId !== this.commandId) {
      throw new Error(
        'Command ID mismatch: ' +
          `expected 0x${this.commandId.toString(16)}, ` +
          `got ${actualCommandId.toString(16)}`
      );
    }

    const actualNumArgs = reader.readUInt8();
    const args = getDlpArgs(this);
    if (actualNumArgs !== args.length) {
      throw new Error(
        'Argument count mismatch: ' +
          `expected ${args.length}, got ${actualNumArgs}`
      );
    }

    let {readOffset} = reader;
    for (const arg of args) {
      readOffset += arg.parseFrom(buffer.slice(readOffset), opts);
    }

    return readOffset;
  }

  serialize(opts?: SerializeOptions): Buffer {
    const serializedArgs = getDlpArgs(this).map((arg) => arg.serialize(opts));
    const writer = new SmartBuffer();
    writer.writeUInt8(this.commandId);
    writer.writeUInt8(serializedArgs.length);
    for (const serializedArg of serializedArgs) {
      writer.writeBuffer(serializedArg);
    }
    return writer.toBuffer();
  }

  getSerializedLength(opts?: SerializeOptions): number {
    return (
      2 + _.sum(getDlpArgs(this).map((arg) => arg.getSerializedLength(opts)))
    );
  }

  /** Execute DLP request and await the response. */
  async execute(
    transport: stream.Duplex,
    {
      requestSerializeOptions,
      responseParseOptions,
    }: {
      requestSerializeOptions?: SerializeOptions;
      responseParseOptions?: ParseOptions;
    } = {}
  ) {
    const serializedRequest = this.serialize(requestSerializeOptions);
    this.log(
      `>>> ${this.constructor.name} ${serializedRequest.toString('hex')}`
    );
    transport.write(serializedRequest);
    const rawResponse = (await pEvent(transport, 'data')) as Buffer;
    this.log(`<<< ${this.responseType.name} ${rawResponse.toString('hex')}`);
    const response = new this.responseType();
    response.parseFrom(rawResponse, responseParseOptions);
    return response;
  }

  private log = debug('DLP');
}

/** Command ID bitmask for DLP responses. */
const DLP_RESPONSE_TYPE_BITMASK = 0x80; // 1000 0000
/** Bitmask for extracting the raw command ID from a DLP response command ID. */
const DLP_RESPONSE_COMMAND_ID_BITMASK = 0xff & ~DLP_RESPONSE_TYPE_BITMASK; // 0111 1111

/** Base class for DLP responses. */
export abstract class DlpResponse implements Serializable {
  /** Expected DLP command ID. */
  abstract commandId: number;

  /** Error code. */
  errno = 0;

  parseFrom(buffer: Buffer, opts?: ParseOptions): number {
    const reader = SmartBuffer.fromBuffer(buffer);
    let actualCommandId = reader.readUInt8();
    if (!(actualCommandId & DLP_RESPONSE_TYPE_BITMASK)) {
      throw new Error(
        `Invalid response command ID: 0x${actualCommandId.toString(16)}`
      );
    }
    actualCommandId &= DLP_RESPONSE_COMMAND_ID_BITMASK;
    if (actualCommandId !== this.commandId) {
      throw new Error(
        'Command ID mismatch: ' +
          `expected 0x${this.commandId.toString(16)}, ` +
          `got ${actualCommandId.toString(16)}`
      );
    }

    const actualNumArgs = reader.readUInt8();
    const args = getDlpArgs(this);
    if (actualNumArgs !== args.length) {
      throw new Error(
        'Argument count mismatch: ' +
          `expected ${args.length}, got ${actualNumArgs}`
      );
    }

    this.errno = reader.readUInt16BE();

    let {readOffset} = reader;
    for (const arg of args) {
      readOffset += arg.parseFrom(buffer.slice(readOffset), opts);
    }

    return readOffset;
  }

  serialize(opts?: SerializeOptions): Buffer {
    const serializedArgs = getDlpArgs(this).map((arg) => arg.serialize(opts));
    const writer = new SmartBuffer();
    writer.writeUInt8(this.commandId | DLP_RESPONSE_TYPE_BITMASK);
    writer.writeUInt8(serializedArgs.length);
    writer.writeUInt16BE(this.errno);
    for (const serializedArg of serializedArgs) {
      writer.writeBuffer(serializedArg);
    }
    return writer.toBuffer();
  }

  getSerializedLength(opts?: SerializeOptions): number {
    return (
      4 + _.sum(getDlpArgs(this).map((arg) => arg.getSerializedLength(opts)))
    );
  }
}

/** DLP argument type, as determined by the payload size. */
export enum DlpArgType {
  TINY = 'tiny',
  SHORT = 'short',
  LONG = 'long',
}

/** Definition of each argument type. */
export interface DlpArgTypeSpec {
  /** Maximum data length supported by this argument type. */
  maxLength: number;
  /** Bitmask applied on the argument ID indicating this argument type. */
  bitmask: number;
  /** Size of argument header when serialized. */
  headerLength: number;
  /** Generate a serialized header for an argument of this type. */
  serializeToHeader: (argId: number, dataLength: number) => Buffer;
  /** Parse a serialized argument header. */
  parseFromHeader: (header: Buffer) => {argId: number; dataLength: number};
}

/** Definition of DLP argument types. */
export const DlpArgTypes: {[K in DlpArgType]: DlpArgTypeSpec} = {
  [DlpArgType.TINY]: {
    maxLength: 0xff,
    bitmask: 0x00, // 0000 0000
    headerLength: 2,
    serializeToHeader(argId: number, dataLength: number) {
      const writer = new SmartBuffer();
      writer.writeUInt8(argId | this.bitmask);
      writer.writeUInt8(dataLength);
      return writer.toBuffer();
    },
    parseFromHeader(header: Buffer) {
      const reader = SmartBuffer.fromBuffer(header);
      return {
        argId: reader.readUInt8() & DLP_ARG_ID_BITMASK,
        dataLength: reader.readUInt8(),
      };
    },
  },
  [DlpArgType.SHORT]: {
    maxLength: 0xffff,
    bitmask: 0x80, // 1000 0000
    headerLength: 4,
    serializeToHeader(argId: number, dataLength: number) {
      const writer = new SmartBuffer();
      writer.writeUInt8(argId | this.bitmask);
      writer.writeUInt8(0); // padding
      writer.writeUInt16BE(dataLength);
      return writer.toBuffer();
    },
    parseFromHeader(header: Buffer) {
      const reader = SmartBuffer.fromBuffer(header);
      return {
        argId: reader.readUInt8() & DLP_ARG_ID_BITMASK,
        padding: reader.readUInt8(), // unused
        dataLength: reader.readUInt16BE(),
      };
    },
  },
  // WARNING: The logic for LONG type arguments differs between pilot-link and
  // ColdSync. Not sure which one is correct - going with the (simpler)
  // pilot-link logic here.
  [DlpArgType.LONG]: {
    maxLength: 0xffffffff,
    bitmask: 0x40, // 0100 0000
    headerLength: 6,
    serializeToHeader(argId: number, dataLength: number) {
      const writer = new SmartBuffer();
      writer.writeUInt8(argId | this.bitmask);
      writer.writeUInt8(0); // padding
      writer.writeUInt32BE(dataLength);
      return writer.toBuffer();
    },
    parseFromHeader(header: Buffer) {
      const reader = SmartBuffer.fromBuffer(header);
      return {
        argId: reader.readUInt8() & DLP_ARG_ID_BITMASK,
        padding: reader.readUInt8(), // unused
        dataLength: reader.readUInt32BE(),
      };
    },
  },
};
/** DlpArgTypes as an array. */
const DlpArgTypesEntries = _.sortBy(
  Object.entries(DlpArgTypes),
  ([_, {maxLength}]) => maxLength
) as Array<[DlpArgType, DlpArgTypeSpec]>;

/** Bitmask for extracting the arg type from a serialized argument ID. */
const DLP_ARG_TYPE_BITMASK = 0xc0; // 1100 0000
/** Bitmask for extracting the raw argument ID from a serialized argument ID. */
const DLP_ARG_ID_BITMASK = 0xff & ~DLP_ARG_TYPE_BITMASK; // 0011 1111

/** ID of the first argument in a DLP request. */
export const DLP_ARG_ID_BASE = 0x20;

/** DLP request argument. */
class DlpArg<ValueT extends Serializable = SBuffer> implements Serializable {
  /** DLP argument ID */
  argId: number;
  /** Argument data. */
  value: ValueT;

  constructor(argId: number, value: ValueT) {
    this.argId = argId;
    this.value = value;
  }

  parseFrom(buffer: Buffer, opts?: ParseOptions): number {
    const reader = SmartBuffer.fromBuffer(buffer);
    // Read first byte to determine arg type.
    const argIdWithArgTypeBitmask = reader.readUInt8();
    const argTypeBits = argIdWithArgTypeBitmask & DLP_ARG_TYPE_BITMASK;
    const argTypeSpec = DlpArgTypesEntries.find(
      ([_, {bitmask}]) => argTypeBits === bitmask
    );
    if (!argTypeSpec) {
      throw new Error(
        'Could not determine argument ID type: ' +
          `0x${argIdWithArgTypeBitmask.toString(16)}`
      );
    }

    // Rewind and read full header.
    reader.readOffset = 0;
    const {headerLength, parseFromHeader} = argTypeSpec[1];
    const headerBuffer = reader.readBuffer(headerLength);
    const {argId, dataLength} = parseFromHeader(headerBuffer);
    this.argId = argId;

    // Read data.
    this.value.parseFrom(reader.readBuffer(dataLength), opts);

    return reader.readOffset;
  }

  serialize(opts?: SerializeOptions): Buffer {
    const writer = new SmartBuffer();
    const serializedData = this.value.serialize(opts);
    writer.writeBuffer(
      this.argTypeSpec.serializeToHeader(this.argId, serializedData.length)
    );
    writer.writeBuffer(serializedData);
    return writer.toBuffer();
  }

  getSerializedLength(opts?: SerializeOptions): number {
    return this.argTypeSpec.headerLength + this.value.getSerializedLength(opts);
  }

  get argType(): DlpArgType {
    const dataLength = this.value.getSerializedLength();
    const dlpArgTypesEntry = DlpArgTypesEntries.find(
      ([_, {maxLength}]) => dataLength <= maxLength
    );
    if (!dlpArgTypesEntry) {
      throw new Error(`Unsupported data length: ${dataLength}`);
    }
    return dlpArgTypesEntry[0];
  }

  get argTypeSpec(): DlpArgTypeSpec {
    return DlpArgTypes[this.argType];
  }
}
