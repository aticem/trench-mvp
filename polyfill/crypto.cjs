// polyfill/crypto.cjs
const nodeCrypto = require('crypto');

if (!globalThis.crypto) {
  if (nodeCrypto.webcrypto) {
    globalThis.crypto = nodeCrypto.webcrypto;
  } else {
    globalThis.crypto = {};
  }
}

if (typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto.getRandomValues = (typedArray) => {
    if (!typedArray || typeof typedArray.length !== 'number' || !ArrayBuffer.isView(typedArray)) {
      throw new TypeError('Expected an instance of TypedArray');
    }
    nodeCrypto.randomFillSync(typedArray);
    return typedArray;
  };
}
