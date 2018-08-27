import { isPrimitive, isArray, isFunction, isDate, isRegExp } from "util";
import { getNameOfBuiltin, getBuiltinByName } from "./builtins";

/**
 * Represents a graph of serialized values.
 */
export class SerializedGraph {
  private indexMap: { element: any, index: number }[];
  private rootIndex: number;
  private contentArray: any[];

  /**
   * Creates a new graph of serialized values.
   */
  private constructor() {
    this.indexMap = [];
    this.rootIndex = -1;
    this.contentArray = [];
  }

  /**
   * Serializes a value, producing a serialized graph.
   * @param value The value to serialize.
   */
  static serialize(value: any): SerializedGraph {
    let graph = new SerializedGraph();
    graph.rootIndex = graph.add(value);
    return graph;
  }

  /**
   * Converts JSON to a serialized graph.
   * @param json The JSON to interpret as a serialized graph.
   */
  static fromJSON(json: any): SerializedGraph {
    let graph = new SerializedGraph();
    graph.rootIndex = json.root;
    graph.contentArray = json.data;
    return graph;
  }

  /**
   * Creates a JSON representation of this serialized graph.
   */
  toJSON() {
    return {
      'root': this.rootIndex,
      'data': this.contentArray
    };
  }

  /**
   * Adds a value to the graph and serializes it
   * if necessary. Returns the index of the value
   * in the content array.
   * @param value The value to add.
   */
  private add(value: any): number {
    // If the value is already in the graph, then we don't
    // need to serialize it.
    for (let { element, index } of this.indexMap) {
      if (element === value) {
        return index;
      }
    }

    let index = this.contentArray.length;
    this.contentArray.push(undefined);
    this.indexMap.push({ element: value, index });
    this.contentArray[index] = this.serialize(value);
    return index;
  }

  /**
   * Serializes a function.
   * @param value The function to serialize.
   */
  private serializeFunction(value: Function): any {
    let closure = (<any>value).__closure;
    if (!closure) {
      closure = () => ({});
    }
    let result = {
      'kind': 'function',
      'source': value.toString(),
      'closure': this.add(closure()),
      'prototype': this.add(value.prototype)
    };

    this.serializeProperties(value, result);

    return result;
  }

  /**
   * Serializes an object.
   * @param value The object to serialize.
   */
  private serializeObject(value: any): any {
    let result = {
      'kind': 'object',
      'prototype': this.add(Object.getPrototypeOf(value))
    };

    this.serializeProperties(value, result);

    return result;
  }

  /**
   * Serializes a value's properties.
   * @param value The value whose properties to serialize.
   * @param serializedValue A serialized version of the value.
   * Its 'refs' and 'descriptions' properties will be updated by this
   * method.
   */
  private serializeProperties(value: any, serializedValue: any): void {
    let refs = {};
    let descriptions = {};
    for (let key of Object.getOwnPropertyNames(value)) {
      if (key === '__closure') {
        continue;
      }

      let desc = Object.getOwnPropertyDescriptor(value, key);
      if ('value' in desc && desc.configurable && desc.writable && desc.enumerable) {
        // Typical property. Just encode its value and be done with it.
        refs[key] = this.add(value[key]);
      } else {
        // Fancy property. We'll emit a description for it.
        let serializedDesc: any = {};
        if (desc.get) {
          serializedDesc.get = this.add(desc.get);
        }
        if (desc.set) {
          serializedDesc.set = this.add(desc.set);
        }
        if ('value' in desc) {
          serializedDesc.value = this.add(desc.value);
        }
        serializedDesc.configurable = desc.configurable;
        if (serializedDesc.writable !== undefined) {
          serializedDesc.writable = desc.writable;
        }
        serializedDesc.enumerable = desc.enumerable;
        descriptions[key] = serializedDesc;
      }
    }

    serializedValue.refs = refs;
    serializedValue.descriptions = descriptions;
  }

  /**
   * Serializes a value. This value may be a closure or an object
   * that contains a closure.
   * @param value The value to serialize.
   */
  private serialize(value: any): any {
    // Check if the value is a builtin before proceeding.
    let builtinName = getNameOfBuiltin(value);
    if (builtinName !== undefined) {
      return {
        'kind': 'builtin',
        'name': builtinName
      };
    }

    // Usual serialization logic.
    if (isPrimitive(value)) {
      return {
        'kind': 'primitive',
        'value': value
      };
    } else if (isArray(value)) {
      return {
        'kind': 'array',
        'refs': value.map(v => this.add(v))
      };
    } else if (isFunction(value)) {
      return this.serializeFunction(value);
    } else if (isDate(value)) {
      return {
        'kind': 'date',
        'value': JSON.stringify(value)
      };
    } else if (isRegExp(value)) {
      return {
        'kind': 'regex',
        'value': value.toString()
      };
    } else {
      return this.serializeObject(value);
    }
  }

  /**
   * Gets a deserialized version of the value
   * stored at a particular index.
   * @param valueIndex The index of the value to deserialize.
   */
  private get(valueIndex: number): any {
    // If the value is already in the index map, then we don't
    // need to deserialize it.
    for (let { element, index } of this.indexMap) {
      if (valueIndex === index) {
        return element;
      }
    }

    let value = this.contentArray[valueIndex];

    if (value.kind === 'primitive') {
      this.indexMap.push({ element: value.value, index: valueIndex });
      return value.value;
    } else if (value.kind === 'array') {
      let results = [];
      // Push the (unfinished) array into the index map here because
      // there may be cycles in the graph of serialized objects.
      this.indexMap.push({ element: results, index: valueIndex });
      for (let ref of value.refs) {
        results.push(this.get(ref));
      }
      return results;
    } else if (value.kind === 'object') {
      // Push the (unfinished) object into the index map here because
      // there may be cycles in the graph of serialized objects.
      let results = Object.create(this.get(value.prototype));
      this.indexMap.push({ element: results, index: valueIndex });
      this.deserializeProperties(value, results);
      return results;
    } else if (value.kind === 'function') {
      // Decoding functions is tricky because the closure of
      // a function may refer to that function. At the same
      // time, function implementations are immutable.
      // To get around that, we'll use a dirty little hack: create
      // a thunk that calls a property of itself.
      let thunk = function() {
        return (<any>thunk).__impl.apply(this, arguments);
      }
      this.indexMap.push({ element: thunk, index: valueIndex });

      // Synthesize a snippet of code we can evaluate.
      let deserializedClosure = this.get(value.closure);
      let capturedVarKeys = [];
      let capturedVarVals = [];
      for (let key in deserializedClosure) {
        capturedVarKeys.push(key);
        capturedVarVals.push(deserializedClosure[key]);
      }
      let code = `(function(${capturedVarKeys.join(", ")}) { return (${value.source}); })`;

      // Evaluate the code.
      let impl = eval(code).apply(undefined, capturedVarVals);
      impl.prototype = this.get(value.prototype);

      // Patch the thunk.
      (<any>thunk).__impl = impl;
      (<any>thunk).prototype = impl.prototype;
      this.deserializeProperties(value, thunk);

      return thunk;
    } else if (value.kind === 'builtin') {
      let builtin = getBuiltinByName(value.name);
      if (builtin === undefined) {
        throw new Error(`Cannot deserialize unknown builtin '${value.name}'.`);
      } else {
        this.indexMap.push({ element: builtin, index: valueIndex });
        return builtin;
      }
    } else if (value.kind === 'date') {
      let result = new Date(JSON.parse(value.value));
      this.indexMap.push({ element: result, index: valueIndex });
      return result;
    } else if (value.kind === 'regex') {
      // TODO: maybe figure out a better way to parse regexes
      // than a call to `eval`?
      let result = eval(value.value);
      this.indexMap.push({ element: result, index: valueIndex });
      return result;
    } else {
      throw new Error(`Cannot deserialize unrecognized content kind '${value.kind}'.`);
    }
  }

  /**
   * Deserializes a serialized value's properties.
   * @param value The serialized value.
   * @param deserializedValue The deserialized value to update.s
   */
  private deserializeProperties(value: any, deserializedValue: any): void {
    for (let key in value.refs) {
      deserializedValue[key] = this.get(value.refs[key]);
    }
    for (let key in value.descriptions) {
      // Object property descriptions require some extra love.
      let desc = value.descriptions[key];
      let parsedDesc = { ...desc, };
      if (desc.get) {
        parsedDesc.get = this.get(desc.get);
      }
      if (desc.set) {
        parsedDesc.set = this.get(desc.set);
      }
      if (desc.value) {
        parsedDesc.value = this.get(desc.value);
      }
      Object.defineProperty(deserializedValue, key, parsedDesc);
    }
  }

  /**
   * Gets a deserialized version of the root object serialized by this graph.
   */
  get root(): any {
    return this.get(this.rootIndex);
  }
}
