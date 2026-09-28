// Bakes soft cast shadows of the relief for a fixed sun into the G channel of each level's
// "lake" texture (R = lake distance field). Done once on the GPU after a level loads.
import * as THREE from 'three';

const VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uH;
uniform sampler2D uLake;
uniform vec2 uTexel;
uniform float uK;          // km per texel
uniform vec2 uSunUV;       // direction towards the sun in texture space (unit)
uniform float uTanElev;
uniform float uExag;
void main() {
  float h0 = max(texture(uH, vUv).r, 0.0) * 0.001 * uExag;
  float occ = 0.0;
  float d = 0.0;
  float st = uK * 0.8;
  for (int i = 0; i < 44; i++) {
    d += st;
    st *= 1.1;
    vec2 p = vUv + uSunUV * (d / uK) * uTexel;
    if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) break;
    float lod = log2(max(st / uK, 1.0)) - 0.5;
    float h = max(textureLod(uH, p, lod).r, 0.0) * 0.001 * uExag;
    float ray = h0 + d * uTanElev;
    // penumbra widens with distance, like a large soft lamp
    occ = max(occ, clamp((h - ray) / (0.04 * d + 0.25 * uK * 0.001 * uExag + 0.02), 0.0, 1.0));
    if (ray > 9.0 * uExag * 0.001 * 1000.0) break;
  }
  fragColor = vec4(texture(uLake, vUv).r, 1.0 - occ, 0.0, 1.0);
}
`;

export function bakeShadows(
  renderer: THREE.WebGLRenderer,
  hTex: THREE.Texture,
  lakeTex: THREE.Texture,
  W: number,
  H: number,
  kmPerTexel: number,
  sunDir: THREE.Vector3,
  exag: number,
): THREE.Texture {
  const rt = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  const s = new THREE.Vector2(sunDir.x, -sunDir.z).normalize(); // map east/north
  const elev = Math.asin(Math.min(1, sunDir.clone().normalize().y));
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'in vec3 position;\n' + VERT,
    fragmentShader: FRAG,
    uniforms: {
      uH: { value: hTex },
      uLake: { value: lakeTex },
      uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
      uK: { value: kmPerTexel },
      // texture v grows southwards
      uSunUV: { value: new THREE.Vector2(s.x, -s.y) },
      uTanElev: { value: Math.tan(elev) },
      uExag: { value: exag },
    },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.Camera();
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev);
  mat.dispose();
  quad.geometry.dispose();
  return rt.texture;
}
