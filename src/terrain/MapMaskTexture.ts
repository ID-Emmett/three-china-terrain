import * as THREE from 'three/webgpu';

/** Upload a north-to-south CPU mask in the orientation expected by map UVs. */
export function createMapMaskTexture(
  data: Uint8Array,
  width: number,
  height: number,
): THREE.DataTexture {
  if (data.length !== width * height) {
    throw new Error(`Map mask size mismatch: ${data.length} !== ${width * height}`);
  }
  const flipped = new Uint8Array(data.length);
  for (let sourceY = 0; sourceY < height; sourceY += 1) {
    const targetY = height - sourceY - 1;
    flipped.set(
      data.subarray(sourceY * width, (sourceY + 1) * width),
      targetY * width,
    );
  }
  const texture = new THREE.DataTexture(
    flipped,
    width,
    height,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
