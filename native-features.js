// Features are centered in part-local millimetres. Both kernels use these
// parameters so that the emitted .forge.js and the offline STL agree.
export const cornerRadius = ([width, depth]) => Math.min(width, depth) / 5;

export function capsuleDimensions(size) {
  const axis = size.indexOf(Math.max(...size));
  const radii = size.map(length => length / 2);
  radii[axis] = Math.min(...radii);
  const offset = size.map((length, i) => i === axis ? length / 2 - radii[i] : 0);
  return {axis, radii, offset};
}

export function forgeNativeFeature({shape, sizeMm}) {
  if (shape === 'roundedPrism') {
    const [width, depth, height] = sizeMm;
    // The sketch origin changed between ForgeCAD releases. moveTo sets the
    // minimum corner on both APIs, preserving our center across versions.
    return `roundedRect(${width}, ${depth}, ${cornerRadius(sizeMm)}).extrude(${height}).moveTo(${-width/2}, ${-depth/2}, ${-height/2})`;
  }
  if (shape === 'capsule') {
    const {axis, radii, offset} = capsuleDimensions(sizeMm);
    const cap = `sphere(1, 48).scale(${JSON.stringify(radii)})`;
    if (offset.every(distance => distance === 0)) return cap;
    // ForgeCAD's classic API supports hull3d. Its newer B-rep API can
    // build the same body as a native elliptic cylinder with two end caps.
    const ends = [offset, offset.map(n => -n)].map(at => `${cap}.translate(${at.join(', ')})`);
    const orientation = ['.rotate([0, 1, 0], 90)', '.rotate([1, 0, 0], -90)', ''][axis];
    const scale = radii.map((r,i) => i === axis ? 1 : r);
    const barrel = `cylinder(${2*offset[axis]}, 1, 1, 48).translate(0, 0, ${-offset[axis]})${orientation}.scale(${JSON.stringify(scale)})`;
    return `(typeof hull3d === "function" ? hull3d(${ends.join(', ')}) : union(${barrel}, ${ends.join(', ')}))`;
  }
  return null;
}

export function manifoldNativeFeature(lib, {shape, sizeMm}, segments) {
  if (shape === 'roundedPrism') {
    const [width, depth, height] = sizeMm;
    const radius = cornerRadius(sizeMm);
    const inner = lib.CrossSection.square([width - 2*radius, depth - 2*radius], true);
    try {
      const profile = inner.offset(radius, 'Round', 2, segments);
      try { return profile.extrude(height, 0, 0, [1, 1], true); }
      finally { profile.delete(); }
    } finally { inner.delete(); }
  }
  if (shape === 'capsule') {
    const {radii, offset} = capsuleDimensions(sizeMm);
    const unit = lib.Manifold.sphere(1, segments);
    const cap = unit.scale(radii);
    unit.delete();
    if (offset.every(distance => distance === 0)) return cap;
    const first = cap.translate(offset);
    const last = cap.translate(offset.map(n => -n));
    try { return lib.Manifold.hull(first, last); }
    finally { first.delete(); last.delete(); cap.delete(); }
  }
  return null;
}
