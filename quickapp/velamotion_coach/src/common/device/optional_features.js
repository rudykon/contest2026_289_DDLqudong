// Board builds may omit these services. Keep loading inside the guard so a
// missing native module cannot prevent the entire page from starting.
export function loadOptionalFeature(name) {
  try {
    let mod = null;
    if (name === 'health') mod = require('@service.health');
    else if (name === 'vibrator') mod = require('@system.vibrator');
    else if (name === 'brightness') mod = require('@system.brightness');
    else if (name === 'battery') mod = require('@system.battery');
    return mod && mod.default ? mod.default : mod;
  } catch (error) {
    console.log('VMC_OPTIONAL_FEATURE unavailable: ' + name);
    return null;
  }
}
