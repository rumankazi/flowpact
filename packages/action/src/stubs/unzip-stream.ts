/**
 * Stands in for unzip-stream in the bundle. @actions/artifact imports it only to download artifacts; the action only
 * uploads them, so unzip-stream and the packages under it stay out of dist/index.js (one of them declares no license).
 */
function unavailable(): never {
  throw new Error('Downloading artifacts is not part of the flowpact action');
}

export default { Extract: unavailable };
