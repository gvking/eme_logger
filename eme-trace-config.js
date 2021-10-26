/**
 * Copyright 2021 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @fileoverview Shim and trace calls to EME, and log them to the extension's
 * log window.
 */

/**
 * A custom logger to plug into TraceAnything.
 */
function emeLogger(log) {
  // Log to the default logger in the JS console first.
  TraceAnything.defaultLogger(log);

  // TODO: Discuss instances and properties with xhwang before finalizing

  // This is not needed and can't be easily serialized.
  delete log.instance;

  window.postMessage({type: 'emeTraceLog', log: prepLogForMessage(log)}, '*');
}

/**
 * @param {Object} log
 * @return {Object}
 */
function prepLogForMessage(log) {
  const clone = {};
  for (const k in log) {
    clone[k] = getSerializable(log[k]);
  }
  return clone;
}

/**
 * @param {*} obj A value that may or may not be serializable.
 * @return {*} A value that can be serialized.
 */
function getSerializable(obj) {
  // Return primitive types directly.
  if (obj == null || typeof obj == 'string' || typeof obj == 'number' ||
      typeof obj == 'boolean') {
    return obj;
  }

  // Events are full of garbage, so only serialize the interesting fields.
  if (obj instanceof Event) {
    const clone = {};
    for (const k in obj) {
      // Skip fields that are in the Event base class, as well as "isTrusted".
      // These are not interesting for logging.
      if (!(k in Event.prototype) && k != 'isTrusted') {
        clone[k] = getSerializable(obj[k]);
      }
    }
    return {
      __type__: obj.type + ' Event',
      __fields__: clone,
    };
  }

  // Elements, Nodes, and Windows are dangerous to serialize because they
  // contain many fields and circular references.
  if (obj instanceof Element) {
    return {
      __type__: '<' + obj.tagName.toLowerCase() + '> element',
    };
  }
  if (obj instanceof Node) {
    return {
      __type__: obj.nodeName.toLowerCase() + ' node',
    };
  }
  if (obj instanceof Window) {
    return {
      __type__: 'Window',
    };
  }

  // Convert array buffers into views.
  // Format views into an object that can be serialized and logged.
  if (obj instanceof ArrayBuffer) {
    obj = new Uint8Array(obj);
  }
  if (ArrayBuffer.isView(obj)) {
    return {
      __type__: obj.constructor.name,
      __data__: Array.from(obj),
    };
  }

  // Get all key statuses and serialize them.
  if (obj instanceof MediaKeyStatusMap) {
    const statuses = {};
    obj.forEach((status, arrayBuffer) => {
      const keyId = uint8ArrayToHexString(new Uint8Array(arrayBuffer));
      statuses[keyId] = status;
    });
    return {
      __type__: obj.constructor.name,
      __fields__: statuses,
    }
  }

  // DOMExceptions don't serialize right if done generically.  None of their
  // properties are their "own".  This follows the same format used below for
  // serializing other typed objects.
  if (obj instanceof DOMException) {
    return {
      __type__: 'DOMException',
      __fields__: {
        name: obj.name,
        code: obj.code,
        message: obj.message,
      },
    };
  }

  // Clone the elements of an array into serializable versions.
  if (Array.isArray(obj)) {
    const clone = [];
    for (const k in obj) {
      if (typeof obj[k] == 'function') {
        clone[k] = {__type__: 'function'};
      } else {
        clone[k] = getSerializable(obj[k]);
      }
    }
    return clone;
  }

  // Clone the fields of an object into serializable versions.
  const clone = {};
  for (const k in obj) {
    if (k == '__TraceAnything__' || typeof obj[k] == 'function') {
      continue;
    }
    clone[k] = getSerializable(obj[k]);
  }
  if (obj.constructor != Object) {
    // If it's an object with a type, send that info, too.
    return {
      __type__: obj.constructor.name,
      __fields__: clone,
    };
  }
  return clone;
}

function byteToHexString(byte) {
  return byte.toString(16).padStart(2, '0');
}

function uint8ArrayToHexString(view) {
  return Array.from(view).map(byteToHexString).join('');
}

function combineOptions(baseOptions, overrideOptions) {
  return Object.assign({}, baseOptions, overrideOptions);
}

// General options for TraceAnything.
const options = {
  // When formatting logs and sending them as serialized messages, we need to
  // wait for async results to be resolved before we log them.
  logAsyncResultsImmediately: false,

  // Our custom logger.  Using an arrow function makes it possible to spy on
  // emeLogger in our tests without breaking this connection.
  logger: (log) => emeLogger(log),

  // Don't bother logging event listener methods.  It's not useful.
  // We can still log events, though.
  skipProperties: [
    'addEventListener',
    'removeEventListener',
  ],
};

// These will be shimmed in place.
TraceAnything.traceMember(navigator, 'requestMediaKeySystemAccess', options);

// These constructors are not used directly, but this registers them to the
// tracing system so that instances we find later will be shimmed.
TraceAnything.traceClass(MediaKeys, options);
TraceAnything.traceClass(MediaKeySystemAccess, options);
TraceAnything.traceClass(MediaKeySession, combineOptions(options, {
  // Also skip logging certain noisy properites on MediaKeySession.
  skipProperties: options.skipProperties.concat([
    'expiration',
  ]),
}));

// Trace media element types, and monitor the document for new instances.
const elementOptions = combineOptions(options, {
  // Skip all property access on media elements.
  // It's a little noisy and unhelpful (currentTime getter, for example).
  properties: false,

  // And these specific events are VERY noisy.  Skip them.
  skipEvents: [
    'progress',
    'timeupdate',
  ],
});
TraceAnything.traceElement('video', elementOptions);
TraceAnything.traceElement('audio', elementOptions);