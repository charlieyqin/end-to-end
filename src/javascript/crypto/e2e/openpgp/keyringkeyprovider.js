/**
 * @license
 * Copyright 2015 Google Inc. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview OpenPGP KeyProvider implementation that uses KeyRing object
 * for the storage.
 */

goog.provide('e2e.openpgp.KeyringKeyProvider');

goog.require('e2e');
goog.require('e2e.algorithm.KeyLocations');
goog.require('e2e.cipher.Algorithm');
goog.require('e2e.openpgp.KeyPurposeType');
goog.require('e2e.openpgp.KeyRing');
goog.require('e2e.openpgp.KeyRingType');
goog.require('e2e.openpgp.KeyringExportFormat');
goog.require('e2e.openpgp.SecretKeyProvider');
goog.require('e2e.openpgp.asciiArmor');
goog.require('e2e.openpgp.block.TransferablePublicKey');
goog.require('e2e.openpgp.block.TransferableSecretKey');
goog.require('e2e.openpgp.block.factory');
goog.require('e2e.openpgp.error.InvalidArgumentsError');
goog.require('e2e.openpgp.error.ParseError');
goog.require('e2e.openpgp.scheme.Ecdh');
goog.require('e2e.scheme.Ecdsa');
goog.require('e2e.scheme.Eme');
goog.require('e2e.scheme.Rsaes');
goog.require('e2e.scheme.Rsassa');
goog.require('e2e.signer.Algorithm');
goog.require('goog.Promise');
goog.require('goog.array');
goog.require('goog.asserts');
goog.require('goog.format.EmailAddress');



/**
 * Secret and public key provider that uses {@link KeyRing} object for storage.
 * All of the keys are implicitly trusted (i.e. {@link #trustKeys} is a no-op).
 * @param {!e2e.openpgp.KeyRing} keyring User's keyring.
 * @constructor
 * @implements {e2e.openpgp.SecretKeyProvider}
 */
e2e.openpgp.KeyringKeyProvider = function(keyring) {
  /** @private {!e2e.openpgp.KeyRing} User's keyring */
  this.keyring_ = keyring;
};


/** @const {!e2e.openpgp.KeyProviderId} */
e2e.openpgp.KeyringKeyProvider.PROVIDER_ID = 'legacy-keyring';


/**
 * Regular expression matching a valid email address. This needs to be very
 * strict and reject uncommon formats to prevent vulnerability when
 * keyserver would choose a different key than intended.
 * @private @const
 */
e2e.openpgp.KeyringKeyProvider.EMAIL_ADDRESS_REGEXP_ =
    /^[+a-zA-Z0-9_.!-]+@([a-zA-Z0-9-]+\.)+[a-zA-Z0-9]{2,63}$/;


/**
 * Deferred constructor.
 * @param  {!goog.Thenable.<!e2e.openpgp.KeyRing>} keyRingPromise
 * @return {!goog.Thenable.<!e2e.openpgp.KeyringKeyProvider>}
 */
e2e.openpgp.KeyringKeyProvider.launch = function(keyRingPromise) {
  return keyRingPromise.then(function(keyring) {
    return new e2e.openpgp.KeyringKeyProvider(keyring);
  });
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.configure = function(config) {
  var configObj = config || {};
  var passphrase = goog.isString(configObj['passphrase']) ?
      configObj['passphrase'] : undefined;

  // Keyring initialization (no-op if the keyring was already initialized).
  return this.keyring_.initialize(passphrase)
      .then(function() {
        // Optionally, change the passphrase.
        if (goog.isString(configObj['newPassphrase'])) {
          return this.keyring_.changePassphrase(configObj['newPassphrase'])
              .then(function() {
                return this.getState();
              }, null, this);
        } else {
          return this.getState();
        }
      });
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.getState = function() {
  return goog.Promise.all([
    this.keyring_.isEncrypted(),
    this.keyring_.hasPassphrase()])
      .then(function(results) {
        var isEncrypted = results[0];
        var hasPassphrase = results[1];
        return /** @type {e2e.openpgp.KeyProviderState}*/ ({
          'encrypted': isEncrypted,
          'locked': !hasPassphrase
        });
      });
};


/**
 * @param {!Array.<!e2e.openpgp.block.TransferableKey>} transferableKeys
 * @return {!e2e.openpgp.Keys} The key objects
 * @private
 */
e2e.openpgp.KeyringKeyProvider.keysToKeyObjects_ = function(transferableKeys) {
  return goog.array.map(transferableKeys,
      e2e.openpgp.KeyringKeyProvider.keyToKeyObject_);
};


/**
 * @param {!e2e.openpgp.block.TransferableKey} transferableKey
 * @return {!e2e.openpgp.Key} The key object
 * @private
 */
e2e.openpgp.KeyringKeyProvider.keyToKeyObject_ = function(transferableKey) {
  return transferableKey.toKeyObject(false,
      e2e.openpgp.KeyringKeyProvider.PROVIDER_ID);
};


/**
 * @param  {!e2e.openpgp.KeyPurposeType} purpose Key purpose.
 * @return {!e2e.openpgp.KeyRing.Type}
 * @private
 */
e2e.openpgp.KeyringKeyProvider.getKeyringType_ = function(purpose) {
  if (purpose == e2e.openpgp.KeyPurposeType.SIGNING ||
      purpose == e2e.openpgp.KeyPurposeType.DECRYPTION) {
    return e2e.openpgp.KeyRing.Type.PRIVATE;
  }
  return e2e.openpgp.KeyRing.Type.PUBLIC;
};


/**
 * Extracts an e-mail address from a RFC-2822 formatted mailbox string.
 * For security, the e-mail address additionally needs to match a restrictive
 * regular expression.
 *
 * See {@link https://tools.ietf.org/html/rfc2822#section-3.4}
 *
 * @param  {string} uid Mailbox address specification
 * @return {?e2e.openpgp.UserEmail} Extracted e-mail address, or null.
 * @private
 */
e2e.openpgp.KeyringKeyProvider.extractValidEmail_ = function(uid) {
  var emailAddress = goog.format.EmailAddress.parse(uid);
  if (!emailAddress.isValid()) {
    return null;
  }
  var email = emailAddress.getAddress();
  if (!e2e.openpgp.KeyringKeyProvider.EMAIL_ADDRESS_REGEXP_.exec(
      emailAddress.getAddress())) {
    return null;
  }
  return email;
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.getId = function() {
  return goog.Promise.resolve(e2e.openpgp.KeyringKeyProvider.PROVIDER_ID);
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.getTrustedKeysByEmail = function(
    purpose, email) {
  return goog.Promise.resolve(undefined)
      .then(function() {
        return this.keyring_.searchKeysByUidMatcher(function(uid) {
          return e2e.openpgp.KeyringKeyProvider.extractValidEmail_(uid) ==
              email;
        },
        e2e.openpgp.KeyringKeyProvider.getKeyringType_(purpose));
      },
      null, this)
      .then(e2e.openpgp.KeyringKeyProvider.keysToKeyObjects_);
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.getKeysByKeyId = function(purpose,
    id) {
  var isSecret;
  switch (purpose) {
    case e2e.openpgp.KeyPurposeType.VERIFICATION:
      isSecret = false;
      break;
    case e2e.openpgp.KeyPurposeType.DECRYPTION:
      isSecret = true;
      break;
    default:
      return goog.Promise.reject(
          new e2e.openpgp.error.InvalidArgumentsError('Invalid key purpose.'));
  }
  // TODO(koto): Support wildcard key id. Return all keys then.
  return goog.Promise.resolve([this.keyring_.getKeyBlockById(id, isSecret)]).
      then(e2e.openpgp.KeyringKeyProvider.keysToKeyObjects_);
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.getAllKeys = function(type) {
  var isSecret = (type == e2e.openpgp.KeyRingType.SECRET);
  var keyMap = this.keyring_.getAllKeys(isSecret);
  var keyObjects = [];
  keyMap.forEach(function(keysForUid, uid) {
    goog.array.forEach(keysForUid, function(key) {
      if (!isSecret && key instanceof e2e.openpgp.block.TransferableSecretKey) {
        // KeyRing.getAllKeys always returns the private keys.
        return;
      }
      keyObjects.push(e2e.openpgp.KeyringKeyProvider.keyToKeyObject_(key));
    }, this);
  }, this);
  return goog.Promise.resolve(keyObjects);
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.getAllKeysByEmail = function(email) {
  return goog.Promise.resolve(undefined).then(function() {
    return this.keyring_.searchKeysByUidMatcher(function(uid) {
      return e2e.openpgp.KeyringKeyProvider.extractValidEmail_(uid) == email;
    }, e2e.openpgp.KeyRing.Type.ALL);
  },
  null, this).
      then(e2e.openpgp.KeyringKeyProvider.keysToKeyObjects_);
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.getKeyByFingerprint = function(
    fingerprint) {
  return goog.Promise.resolve(this.keyring_.getPublicKeyBlockByFingerprint(
      fingerprint)).then(
      function(key) {
        return key ? e2e.openpgp.KeyringKeyProvider.keyToKeyObject_(key) : null;
      });
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.getKeyringExportOptions = function(
    keyringType) {
  return goog.Promise.resolve(keyringType).then(function(keyringType) {
    var options = [];
    switch (keyringType) {
      case e2e.openpgp.KeyRingType.PUBLIC:
        options.push(/** @type {e2e.openpgp.KeyringExportOptions} */ ({
          'format': e2e.openpgp.KeyringExportFormat.OPENPGP_PACKETS_ASCII
        }));
        options.push(/** @type {e2e.openpgp.KeyringExportOptions} */ ({
          'format': e2e.openpgp.KeyringExportFormat.OPENPGP_PACKETS_BINARY
        }));
        break;
      case e2e.openpgp.KeyRingType.SECRET:
        options.push(/** @type {e2e.openpgp.KeyringExportOptions} */ ({
          'format': e2e.openpgp.KeyringExportFormat.OPENPGP_PACKETS_ASCII,
          'passphrase': null
        }));
        options.push(/** @type {e2e.openpgp.KeyringExportOptions} */ ({
          'format': e2e.openpgp.KeyringExportFormat.OPENPGP_PACKETS_BINARY,
          'passphrase': null
        }));
        if (this.keyring_.getKeyringBackupData().seed) {
          options.push(/** @type {e2e.openpgp.KeyringExportOptions} */ ({
            'format': 'backup-code',
          }));
        }
        break;
    }
    return options;
  }, null, this);
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.exportKeyring = function(keyringType,
    exportOptions) {
  return goog.Promise.resolve(exportOptions).then(function(exportOptions) {
    switch (exportOptions.format) {
      case e2e.openpgp.KeyringExportFormat.OPENPGP_PACKETS_ASCII:
        return this.exportAllKeys_(keyringType, true,
            exportOptions['passphrase']);
        break;
      case e2e.openpgp.KeyringExportFormat.OPENPGP_PACKETS_BINARY:
        return this.exportAllKeys_(keyringType, false,
            exportOptions['passphrase']);
        break;
      case 'backup-code':
        if (keyringType == e2e.openpgp.KeyRingType.SECRET) {
          return this.keyring_.getKeyringBackupData();
        }
        break;
      default:
        throw new e2e.openpgp.error.InvalidArgumentsError(
            'Invalid export options.');
    }
  }, null, this);
};


/**
 * Exports a serialization of a public or private keyring.
 * @param {!e2e.openpgp.KeyRingType} keyringType The type of the keyring.
 * @param {boolean} asciiArmor If true, export will be ASCII armored, otherwise
 *     bytes will be returned.
 * @param {string=} opt_passphrase A passphrase to lock the private keys with.
 * @return {!goog.Thenable<string|!e2e.ByteArray>} Key blocks for all keys in a
 *     given keyring type. Private key exports also include all matching public
 *     key blocks.
 * @private
 */
e2e.openpgp.KeyringKeyProvider.prototype.exportAllKeys_ = function(
    keyringType, asciiArmor, opt_passphrase) {
  return goog.Promise.resolve()
      .then(goog.bind(
          this.serializeAllKeyBlocks_,
          this,
          keyringType,
          asciiArmor,
          opt_passphrase))
      .then(goog.bind(
          this.encodeKeyringExport_,
          this,
          keyringType,
          asciiArmor));
};


/**
 * Serializes all key blocks from a given keyring.
 * @param  {!e2e.openpgp.KeyRingType} keyringType Type of the keyring.
 * @param {boolean} asciiArmor If true, export will be ASCII armored, otherwise
 *     bytes will be returned.
 * @param  {string=} opt_passphrase A passphrase to lock the private keys with.
 * @return {!e2e.ByteArray} Serialization of all key blocks.
 * @private
 */
e2e.openpgp.KeyringKeyProvider.prototype.serializeAllKeyBlocks_ = function(
    keyringType, asciiArmor, opt_passphrase) {

  var isSecret = (keyringType == e2e.openpgp.KeyRingType.SECRET);
  var passphraseBytes = null;
  if (goog.isString(opt_passphrase) && opt_passphrase !== '') {
    if (!isSecret) {
      throw new e2e.openpgp.error.InvalidArgumentsError(
          'Cannot use passphrase during a public keyring export.');
    }
    passphraseBytes = e2e.stringToByteArray(opt_passphrase);
  }
  var keyMap = this.keyring_.getAllKeys(isSecret);
  var serializedKeys = [];
  keyMap.forEach(function(keysForUid, uid) {
    goog.array.forEach(keysForUid, function(key) {
      goog.array.extend(serializedKeys,
          this.serializeKey_(isSecret, passphraseBytes, key));
    }, this);
  }, this);
  return serializedKeys;
};


/**
 * Encoded the OpenPGP blocks serialization for export.
 * @param  {!e2e.openpgp.KeyRingType} keyringType Type of the keyring.
 * @param {boolean} asciiArmor If true, export will be ASCII armored, otherwise
 *     bytes will be returned.
 * @param  {!e2e.ByteArray} serialized Serialized keys
 * @return {string|!e2e.ByteArray} Optionally ASCII-armored serialization.
 * @private
 */
e2e.openpgp.KeyringKeyProvider.prototype.encodeKeyringExport_ = function(
    keyringType, asciiArmor, serialized) {
  if (asciiArmor) {
    var header = (keyringType == e2e.openpgp.KeyRingType.SECRET) ?
        'PRIVATE KEY BLOCK' : 'PUBLIC KEY BLOCK';
    return e2e.openpgp.asciiArmor.encode(header, serialized);
  }
  return serialized;
};


/**
 * Validates, optionally locks and serializes the key. For private keys also
 * serializes the matching public key block.
 * @param  {boolean} isSecret True iff private key is expected.
 * @param  {?e2e.ByteArray} passphraseBytes Passphrase to use to lock
 *     the secret key.
 * @param  {!e2e.openpgp.block.TransferableKey}  key The key block.
 * @return {!e2e.ByteArray} Serialization of the key(s)
 * @private
 */
e2e.openpgp.KeyringKeyProvider.prototype.serializeKey_ = function(
    isSecret, passphraseBytes, key) {
  var matchingKey;
  var serialized = [];
  if (isSecret) {
    goog.asserts.assert(key instanceof e2e.openpgp.block.TransferableSecretKey);
    // Protect with passphrase
    key.processSignatures();
    key.unlock();
    key.lock(goog.isNull(passphraseBytes) ? undefined :
        goog.asserts.assertArray(passphraseBytes));
    // Also add the public key block for this secret key.
    matchingKey = this.keyring_.getPublicKeyBlockByFingerprint(
        key.keyPacket.fingerprint);
  } else {
    if (!(key instanceof e2e.openpgp.block.TransferablePublicKey)) {
      // KeyRing.getAllKeys always returns the private keys, ignore them.
      return [];
    }
  }
  goog.array.extend(serialized, key.serialize());
  if (matchingKey) {
    goog.array.extend(serialized, matchingKey.serialize());
  }
  return serialized;
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.setCredentials = function(
    credentials) {
  // Ignored.
  return goog.Promise.resolve();
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.trustKeys = function(keys, email,
    purpose, opt_trustData) {
  // In the keyring, all keys are trusted.
  return goog.Promise.resolve(keys);
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.removeKeys = function(keys) {
  goog.array.forEach(keys, function(key) {
    var keyringType = e2e.openpgp.KeyRing.Type.PUBLIC;
    if (key.key.secret) {
      keyringType = e2e.openpgp.KeyRing.Type.PRIVATE;
    }
    this.keyring_.deleteKeyByFingerprint(key.key.fingerprint, keyringType);
  }, this);
  return goog.Promise.resolve(undefined);
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.importKeys = function(keySerialization,
    passphraseCallback) {
  return goog.Promise.resolve(undefined).then(function() {
    var blocks = e2e.openpgp.block.factory.parseByteArrayAllTransferableKeys(
        keySerialization, true /* skip keys with errors */);
    if (blocks.length == 0) {
      throw new e2e.openpgp.error.ParseError('No valid key blocks found.');
    }
    return blocks;
  }).then(function(keys) {
    return goog.Promise.all(goog.array.map(keys, function(key) {
      return this.keyring_.importKey(key).addCallback(function(imported) {
        // KeyRing.importKey returns a boolean, but we need a key object of
        // a successfully imported key, or null otherwise.
        return imported ? key : null;
      });
    }, this));
  }, null, this).then(function(keysOrNull) {
    return e2e.openpgp.KeyringKeyProvider.keysToKeyObjects_(
        goog.array.filter(keysOrNull, goog.isDefAndNotNull));
  });
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.decrypt = function(key, keyId,
    algorithm, ciphertext) {
  return goog.Promise.resolve(key)
      .then(goog.bind(this.getSecretKeyPacket_, this, keyId))
      .then(goog.bind(this.requireDecryptionScheme_, this, algorithm))
      .then(function(scheme) {
        return scheme.decrypt(ciphertext);
      });
};


/**
 * Retrieves the secret key packet from a given Key object.
 * @param {!e2e.openpgp.KeyId} keyId
 * @param {!e2e.openpgp.Key} key The key object that the packet should
 *     originate from.
 * @return {e2e.openpgp.packet.SecretKey} The key packet
 * @private
 */
e2e.openpgp.KeyringKeyProvider.prototype.getSecretKeyPacket_ = function(keyId,
    key) {
  if (key.providerId !== e2e.openpgp.KeyringKeyProvider.PROVIDER_ID ||
      !key.key.secret) {
    throw new e2e.openpgp.error.InvalidArgumentsError('Invalid key handle.');
  }
  return this.keyring_.getSecretKey(keyId, key.key.fingerprint);
};


/**
 * Returns the matching decryption scheme for a given key packet. Throws an
 * error on algorithm mismatch.
 * @param  {!e2e.cipher.Algorithm} algorithm Requested decryption algorithm.
 * @param  {e2e.openpgp.packet.SecretKey} secretKeyPacket Secret key packet
 *     to extract the cipher from.
 * @return {!e2e.scheme.EncryptionScheme} The scheme.
 * @private
 */
e2e.openpgp.KeyringKeyProvider.prototype.requireDecryptionScheme_ = function(
    algorithm, secretKeyPacket) {
  if (!secretKeyPacket) {
    throw new e2e.openpgp.error.InvalidArgumentsError(
        'Could not find a key.');
  }
  var cipher = /** @type {!e2e.cipher.Cipher} */ (goog.asserts.assertObject(
      secretKeyPacket.cipher.getWrappedCipher()));
  if (algorithm !== cipher.algorithm) {
    throw new e2e.openpgp.error.InvalidArgumentsError(
        'Cipher algorithm mismatch.');
  }
  if (!goog.isFunction(cipher.decrypt)) {
    throw new e2e.openpgp.error.InvalidArgumentsError('Invalid cipher.');
  }
  switch (cipher.algorithm) {
    case e2e.cipher.Algorithm.RSA:
    case e2e.cipher.Algorithm.RSA_ENCRYPT:
      return new e2e.scheme.Rsaes(cipher);
      break;
    case e2e.cipher.Algorithm.ECDH:
      return new e2e.openpgp.scheme.Ecdh(cipher);
      break;
    case e2e.cipher.Algorithm.ELGAMAL:
      return new e2e.scheme.Eme(cipher);
      break;
  }
  throw new e2e.openpgp.error.InvalidArgumentsError(
      'Could not find a matching decryption scheme.');
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.sign = function(key, keyId,
    algorithm, hashAlgorithm, data) {
  return goog.Promise.resolve(key)
      .then(goog.bind(this.getSecretKeyPacket_, this, keyId))
      .then(goog.bind(this.requireSignatureScheme_, this, algorithm,
          hashAlgorithm))
      .then(function(scheme) {
        return scheme.sign(data);
      });
};


/**
 * Returns the matching signature scheme for a given key packet. Throws an
 * error on algorithm mismatch.
 * @param  {!e2e.cipher.Algorithm} algorithm Requested signing algorithm.
 * @param  {!e2e.hash.Algorithm} hashAlgorithm Requested signing hash algorithm.
 * @param  {e2e.openpgp.packet.SecretKey} secretKeyPacket Secret key packet
 *     to extract the cipher from.
 * @return {!e2e.scheme.SignatureScheme|!e2e.signer.Signer} The scheme.
 * @private
 */
e2e.openpgp.KeyringKeyProvider.prototype.requireSignatureScheme_ = function(
    algorithm, hashAlgorithm, secretKeyPacket) {
  if (!secretKeyPacket) {
    throw new e2e.openpgp.error.InvalidArgumentsError(
        'Could not find a key.');
  }
  var signer = /** @type {e2e.signer.Signer} */ (goog.asserts.assertObject(
      secretKeyPacket.cipher.getWrappedCipher()));
  if (algorithm !== signer.algorithm ||
      hashAlgorithm !== signer.getHashAlgorithm()) {
    throw new e2e.openpgp.error.InvalidArgumentsError(
        'Signer algorithm mismatch.');
  }

  if (!goog.isFunction(signer.sign)) {
    throw new e2e.openpgp.error.InvalidArgumentsError('Invalid signer.');
  }
  switch (signer.algorithm) {
    case e2e.cipher.Algorithm.RSA:
    case e2e.signer.Algorithm.RSA_SIGN:
      return new e2e.scheme.Rsassa(signer);
      break;
    case e2e.signer.Algorithm.ECDSA:
      return new e2e.scheme.Ecdsa(signer);
      break;
    case e2e.signer.Algorithm.DSA:
      return signer;
      break;
  }
  throw new e2e.openpgp.error.InvalidArgumentsError(
      'Could not find a matching signature scheme.');
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.generateKeyPair = function(userId,
    generateOptions) {
  return this.validateGenerateOptions_(generateOptions)
      .then(function(options) {
        return this.keyring_.generateKey(userId,
           options['keyAlgo'],
           options['keyLength'],
           options['subkeyAlgo'],
           options['subkeyLength'],
           options['keyLocation']);
      }, null, this)
      .then(function(transferableKeys) {
        var pubKeyBlock = transferableKeys[0];
        var privKeyBlock = transferableKeys[1];
        return /** @type {e2e.openpgp.KeyPair} */ ({
          'public': e2e.openpgp.KeyringKeyProvider.keyToKeyObject_(pubKeyBlock),
          'secret': e2e.openpgp.KeyringKeyProvider.keyToKeyObject_(privKeyBlock)
        });
      }, null, this);
};


/**
 * Validates the key generation options.
 * @param  {!e2e.openpgp.KeyGenerateOptions} generateOptions Keypair generation
 *     options
 * @return {!goog.Thenable<!e2e.openpgp.KeyGenerateOptions>}
 * @private
 */
e2e.openpgp.KeyringKeyProvider.prototype.validateGenerateOptions_ = function(
    generateOptions) {
  return new goog.Promise(function(resolve, reject) {
    if (!goog.isNumber(generateOptions['keyLength']) ||
        generateOptions['keyLength'] <= 0) {
      throw new e2e.openpgp.error.InvalidArgumentsError('Invalid keyLength');
    }
    if (!goog.isNumber(generateOptions['subkeyLength']) ||
        generateOptions['subkeyLength'] <= 0) {
      throw new e2e.openpgp.error.InvalidArgumentsError(
          'Invalid subkeyLength');
    }
    if (!generateOptions['keyAlgo'] in e2e.signer.Algorithm) {
      throw new e2e.openpgp.error.InvalidArgumentsError('Invalid keyAlgo');
    }
    if (!generateOptions['subkeyAlgo'] in e2e.cipher.Algorithm) {
      throw new e2e.openpgp.error.InvalidArgumentsError('Invalid subkeyAlgo');
    }
    if (!generateOptions['keyLocation'] in e2e.algorithm.KeyLocations) {
      throw new e2e.openpgp.error.InvalidArgumentsError('Invalid keyLocation');
    }
    resolve(generateOptions);
  });
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.getKeyGenerateOptions = function() {
  // WebCrypto RSA is no longer possible in Chrome:
  // https://www.chromium.org/blink/webcrypto
  // https://www.w3.org/Bugs/Public/show_bug.cgi?id=25431
  var webCryptoKeyGenerateOptions = {
    keyAlgo: [e2e.signer.Algorithm.RSA],
    keyLength: [4096, 8192],
    subkeyAlgo: [e2e.cipher.Algorithm.RSA],
    subkeyLength: [4096, 8192],
    keyLocation: [e2e.algorithm.KeyLocations.WEB_CRYPTO]
  };
  var javascriptKeyGenerateOptions = {
    keyAlgo: [e2e.signer.Algorithm.ECDSA],
    keyLength: [256],
    subkeyAlgo: [e2e.cipher.Algorithm.ECDH],
    subkeyLength: [256],
    keyLocation: [e2e.algorithm.KeyLocations.JAVASCRIPT]
  };
  return goog.Promise.resolve([javascriptKeyGenerateOptions]);
};


/** @override */
e2e.openpgp.KeyringKeyProvider.prototype.unlockKey = function(key, unlockData) {
  // In the keyring, all keys are unlocked.
  return goog.Promise.resolve(/** @type {e2e.openpgp.Key} */ (key));
};
