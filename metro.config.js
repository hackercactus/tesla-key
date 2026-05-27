const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Push .pem into the whitelist array so Metro bundles the cryptographic keys
config.resolver.assetExts.push('pem');

module.exports = config;