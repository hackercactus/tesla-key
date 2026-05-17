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

      if (contents.includes('SWIFT_STRICT_CONCURRENCY')) {
        return mod;
      }

      const block = `
# ── Swift 6 / Xcode 16.4 workaround ─────────────────────────────────────────
post_install do |installer|
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings['SWIFT_STRICT_CONCURRENCY'] = 'minimal'
    end
  end
end
# ─────────────────────────────────────────────────────────────────────────────
`;

      contents += block;
      fs.writeFileSync(podfilePath, contents);
      return mod;
    },
  ]);
};