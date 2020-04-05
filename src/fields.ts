import {PromiseReadable} from 'promise-readable';

/**
 * Field type is a leading byte that indicates what the field is.
 */
export enum FieldType {
  UInt8 = 0x0f,
  UInt16 = 0x10,
  UInt32 = 0x11,
  String = 0x26,
  Binary = 0x14,
}

/**
 * The generic interface for all field types
 */
interface BaseField {
  /**
   * The raw field data
   */
  data: Buffer;
  /**
   * Corce the field into a buffer. This differes from reading the data
   * property in that it will include the field type header.
   */
  readonly buffer: Buffer;
}

class BaseField {
  /**
   * Declares the type of field this class represents
   */
  static type: FieldType;

  /**
   * The number of bytes to read for this field. If the field is not a fixed size,
   * set this to true, causing the parser to read a single UInt32 to determine the
   * field length.
   */
  static bytesToRead: number | false = false;
}

export type NumberField = BaseField & {
  /**
   * The fields number value
   */
  value: number;
};

export type StringField = BaseField & {
  /**
   * The fields decoded string value
   */
  value: string;
};

export type BinaryField = BaseField & {
  /**
   * The binary value encapsulated in the field
   */
  value: Buffer;
};

type NumberFieldType = FieldType.UInt32 | FieldType.UInt16 | FieldType.UInt8;

const numberBufferInfo = {
  [FieldType.UInt8]: [1, 'writeUInt8', 'readUInt8'],
  [FieldType.UInt16]: [2, 'writeUInt16BE', 'readUInt16BE'],
  [FieldType.UInt32]: [4, 'writeUInt32BE', 'readUInt32BE'],
} as const;

function parseNumber(value: number | Buffer, type: NumberFieldType): [number, Buffer] {
  const [bytes, writeFn, readFn] = numberBufferInfo[type];
  const data = Buffer.alloc(bytes);

  if (typeof value === 'number') {
    data[writeFn](value);
    return [value, data];
  }

  return [value[readFn](), value];
}

function makeVariableBuffer(type: FieldType, fieldData: Buffer) {
  const data = Buffer.alloc(fieldData.length + 4 + 1);
  data.writeUInt8(type);
  data.writeUInt32BE(fieldData.length, 0x01);

  fieldData.copy(data, 0x05);

  return data;
}

const makeNumberField = (type: NumberFieldType) =>
  class Number extends BaseField implements NumberField {
    static bytesToRead = numberBufferInfo[type][0];
    static type = type;

    value: number;

    constructor(value: number | Buffer) {
      super();
      const [number, data] = parseNumber(value, type);
      this.data = data;
      this.value = number;
    }

    get buffer() {
      return Buffer.from([type, ...this.data]);
    }
  };

export type Field = NumberField | StringField | BinaryField;

/**
 * Field representing a UInt8
 */
export const UInt8 = makeNumberField(FieldType.UInt8);

/**
 * Field representing a UInt16
 */
export const UInt16 = makeNumberField(FieldType.UInt16);

/**
 * Field representing a UInt32
 */
export const UInt32 = makeNumberField(FieldType.UInt32);

/**
 * Field representing a big endian UTF-16 string
 */
export class String extends BaseField implements StringField {
  static bytesToRead = false as const;
  type = FieldType.String as const;

  value: string;

  constructor(value: Buffer | string) {
    super();
    if (typeof value === 'string') {
      this.value = value;
      this.data = Buffer.from(value, 'utf16le').swap16();
      return;
    }

    this.value = Buffer.from(value).swap16().toString('utf16le');
    this.data = value;
  }

  get buffer() {
    return makeVariableBuffer(FieldType.String, this.data);
  }
}

/**
 * Field representing binary data
 */
export class Binary extends BaseField implements BinaryField {
  static bytesToRead = false as const;
  static type = FieldType.Binary as const;

  value: Buffer;

  constructor(value: Buffer) {
    super();
    this.value = this.data = value;
  }

  get buffer() {
    return makeVariableBuffer(FieldType.Binary, this.data);
  }
}

const fieldMap = {
  [FieldType.UInt8]: UInt8,
  [FieldType.UInt16]: UInt16,
  [FieldType.UInt32]: UInt32,
  [FieldType.String]: String,
  [FieldType.Binary]: Binary,
} as const;

/**
 * Helper to read from stream.
 *
 * NOTE: I suspect the typescript interface on PromiseReadable may be wrong, as
 * I'm not sure when this would return a string. We'll play it safe for now.
 */
async function read(stream: PromiseReadable<any>, bytes: number) {
  const data = await stream.read(bytes);

  if (data instanceof Buffer) {
    return data;
  }

  throw new Error('Expected buffer from stream read');
}

/**
 * Read a single field from a socket stream.
 */
export async function readField<
  T extends FieldType,
  F extends InstanceType<typeof fieldMap[T]>
>(stream: PromiseReadable<any>, expect?: T): Promise<F> {
  const typeData = await read(stream, 1);
  const Field = fieldMap[typeData[0] as FieldType];

  if (expect && Field.type !== expect) {
    throw new Error(`Expected ${fieldMap[expect].name} but got ${Field.name}`);
  }

  let nextByteCount: number;

  if (Field.bytesToRead !== false) {
    nextByteCount = Field.bytesToRead;
  } else {
    // Read the field length as a UInt32 when we do not know the field length
    // from the type
    const lengthData = await read(stream, 4);
    nextByteCount = lengthData.readUInt32BE();
  }

  return new Field(await read(stream, nextByteCount)) as F;
}
