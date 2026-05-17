const { withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs   = require('fs');

module.exports = function withSwift6Fix(config) {
  return withDangerousMod(config, [
    'ios',
    (mod) => {
      const podfilePath = path.join(
        mod.modRequest.platformProjectRoot,
        'Podfile',
      );

      let contents = fs.readFileSync(podfilePath, 'utf-8');

      // Guard: do not inject twice
      if (contents.includes('SWIFT_STRICT_CONCURRENCY')) {
        return mod;
      }

      // Find Expo's native post_install block and inject our code directly inside it
      const injection = `post_install do |installer|
  # ── Swift 6 / Xcode 16.4 workaround ─────────────────────────────────────────
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'
    end
  end
  # ─────────────────────────────────────────────────────────────────────────────
`;
      
      // Replace the declaration line with our injected version
      contents = contents.replace('post_install do |installer|', injection);

      fs.writeFileSync(podfilePath, contents);
      return mod;
    },
  ]);
};