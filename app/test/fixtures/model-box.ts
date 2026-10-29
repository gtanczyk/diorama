/** A small, deterministic GLB with real triangles. Its transform exercises model-space normalisation. */
export function boxGlb(size: [number, number, number], scale = 1, translation = [0, 0, 0], texture?: Buffer): Buffer {
  const corners = Array.from({ length: 8 }, (_, i) => size.map((s, a) => ((i >> a) & 1 ? 0.5 : -0.5) * s));
  const faces = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5];
  const positions = new Float32Array(faces.flatMap((i) => corners[i]));
  const uv = new Float32Array(positions.length / 3 * 2).fill(0.5);
  const bin = Buffer.concat([Buffer.from(positions.buffer), ...(texture ? [Buffer.from(uv.buffer)] : [])]);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, scale: [scale, scale, scale], translation }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, ...(texture ? { TEXCOORD_0: 1 } : {}) }, ...(texture ? { material: 0 } : {}) }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: size.map((s) => -s / 2), max: size.map((s) => s / 2) },
      ...(texture ? [{ bufferView: 1, componentType: 5126, count: uv.length / 2, type: 'VEC2' }] : [])],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }, ...(texture ? [{ buffer: 0, byteOffset: positions.byteLength, byteLength: uv.byteLength }] : [])], buffers: [{ byteLength: bin.length }],
    ...(texture ? {
      images: [{ uri: `data:image/png;base64,${texture.toString('base64')}` }], textures: [{ source: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }],
    } : {}),
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, ' ')]);
  const header = Buffer.alloc(20), chunk = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length + 8 + bin.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  chunk.writeUInt32LE(bin.length, 0); chunk.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, json, chunk, bin]);
}
